import { describe, expect, it } from 'vitest';
import {
  colombianMobileSchema,
  normalizeColombianMobile,
  whatsappConnectSchema,
  whatsappNumberUpdateSchema,
} from '../src/whatsapp-schemas';

const CLOUD = {
  provider: 'cloud' as const,
  phoneNumberId: '109876543210987',
  accessToken: 'EAAG'.padEnd(180, 'x'),
  appSecret: 'a'.repeat(32),
  verifyToken: 'ventia-verify-2026',
  displayPhone: '300 123 4567',
};

const EVOLUTION = {
  provider: 'evolution' as const,
  instanceName: 'ventia-dev-01',
  apiKey: 'evolution-api-key-abc123',
  baseUrl: 'http://localhost:8080',
  displayPhone: '+57 310 987 6543',
};

describe('normalizeColombianMobile', () => {
  // The shapes a Colombian merchant actually types into an admin form: bare
  // 10 digits, spaced by carrier convention, hyphenated, with +57 from a
  // contact card, with 57 from a pasted WhatsApp link, with 0057 from a
  // landline-dialing habit, and with parentheses around the prefix.
  const sameNumber = [
    '3001234567',
    '300 123 4567',
    '300-123-4567',
    '300.123.4567',
    '(300) 1234567',
    '+573001234567',
    '+57 300 123 4567',
    '+57 (300) 123-4567',
    '573001234567',
    '57 300 123 4567',
    '00573001234567',
    '0057 300 123 4567',
    '  3001234567  ',
    '300\u00a0123\u00a04567', // non-breaking spaces, as pasted from a web page
  ];

  it.each(sameNumber)('normalizes %j to +573001234567', (input) => {
    expect(normalizeColombianMobile(input)).toBe('+573001234567');
  });

  it('preserves the distinct 3xx prefixes of the different carriers', () => {
    expect(normalizeColombianMobile('310 987 6543')).toBe('+573109876543');
    expect(normalizeColombianMobile('321 555 0000')).toBe('+573215550000');
    expect(normalizeColombianMobile('350 111 2233')).toBe('+573501112233');
  });

  const rejected: Array<[string, string]> = [
    ['6012345678', 'a Bogotá landline in the post-2022 10-digit form'],
    ['12345678', 'an old-style landline with area code'],
    ['4571234', 'a 7-digit local landline'],
    ['123', 'a short code'],
    ['30012345', 'a mobile missing two digits'],
    ['30012345678', 'a mobile with an extra digit'],
    ['+13001234567', 'a US number that happens to start with 3 after the code'],
    ['+576012345678', 'a landline written in international form'],
    ['300123456a', 'a typo that leaves a letter behind'],
    ['300 123 4567 ext 2', 'an extension the sender could never dial on WhatsApp'],
    ['', 'an empty string'],
    ['+57', 'a country code with no number'],
  ];

  it.each(rejected)('rejects %j (%s)', (input) => {
    expect(normalizeColombianMobile(input)).toBeNull();
  });
});

describe('colombianMobileSchema', () => {
  it('outputs the canonical form, not what was typed', () => {
    expect(colombianMobileSchema.parse('300 123 4567')).toBe('+573001234567');
  });

  it('explains what a valid number looks like when it rejects a landline', () => {
    const result = colombianMobileSchema.safeParse('6012345678');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/celular colombiano/i);
    }
  });

  it('rejects an over-long value on length before running the normalizer', () => {
    const result = colombianMobileSchema.safeParse('3'.repeat(200));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe('too_big');
    }
  });
});

describe('whatsappConnectSchema — cloud', () => {
  it('accepts a full Cloud API connection and normalizes displayPhone', () => {
    const parsed = whatsappConnectSchema.parse(CLOUD);
    expect(parsed.provider).toBe('cloud');
    if (parsed.provider === 'cloud') {
      expect(parsed.phoneNumberId).toBe('109876543210987');
      expect(parsed.displayPhone).toBe('+573001234567');
    }
  });

  it('requires appSecret and verifyToken — a Cloud number cannot be saved unverifiable', () => {
    const partial: Record<string, unknown> = { ...CLOUD };
    delete partial.appSecret;
    delete partial.verifyToken;
    const result = whatsappConnectSchema.safeParse(partial);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('appSecret');
      expect(paths).toContain('verifyToken');
    }
  });

  it('rejects a phoneNumberId with path characters in it', () => {
    for (const bad of ['1098/../other', '109876543210987?x=1', 'abc123']) {
      expect(whatsappConnectSchema.safeParse({ ...CLOUD, phoneNumberId: bad }).success).toBe(false);
    }
  });

  const overLong: Array<[keyof typeof CLOUD, number]> = [
    ['phoneNumberId', 32],
    ['accessToken', 512],
    ['appSecret', 128],
    ['verifyToken', 128],
  ];

  it.each(overLong)('bounds %s at %i characters', (field, max) => {
    const filler = field === 'phoneNumberId' ? '1' : 'x';
    const atMax = whatsappConnectSchema.safeParse({ ...CLOUD, [field]: filler.repeat(max) });
    expect(atMax.success).toBe(true);

    const overMax = whatsappConnectSchema.safeParse({ ...CLOUD, [field]: filler.repeat(max + 1) });
    expect(overMax.success).toBe(false);
    if (!overMax.success) {
      expect(overMax.error.issues.some((i) => i.path.join('.') === field && i.code === 'too_big')).toBe(true);
    }
  });

  it('rejects a secret carrying a newline, which would be header injection', () => {
    const result = whatsappConnectSchema.safeParse({
      ...CLOUD,
      accessToken: 'EAAGvalidlooking\r\nX-Injected: 1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a secret too short to be one', () => {
    expect(whatsappConnectSchema.safeParse({ ...CLOUD, verifyToken: 'abc' }).success).toBe(false);
  });
});

describe('whatsappConnectSchema — evolution', () => {
  it('accepts a self-hosted Evolution instance on http (the dev provider)', () => {
    const parsed = whatsappConnectSchema.parse(EVOLUTION);
    expect(parsed.provider).toBe('evolution');
    if (parsed.provider === 'evolution') {
      expect(parsed.instanceName).toBe('ventia-dev-01');
      expect(parsed.baseUrl).toBe('http://localhost:8080');
      expect(parsed.displayPhone).toBe('+573109876543');
    }
  });

  it('does not accept Cloud-only fields as a substitute for its own', () => {
    const result = whatsappConnectSchema.safeParse({
      provider: 'evolution',
      phoneNumberId: '109876543210987',
      accessToken: 'x'.repeat(40),
      displayPhone: '3001234567',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an instanceName with a path separator', () => {
    for (const bad of ['ventia/../admin', 'ventia dev', 'ventia?x']) {
      expect(whatsappConnectSchema.safeParse({ ...EVOLUTION, instanceName: bad }).success).toBe(false);
    }
  });

  it('rejects a baseUrl that is not http(s)', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'localhost:8080', 'ftp://host/x']) {
      expect(whatsappConnectSchema.safeParse({ ...EVOLUTION, baseUrl: bad }).success).toBe(false);
    }
  });

  const overLong: Array<[string, number, string]> = [
    ['instanceName', 64, 'a'],
    ['apiKey', 256, 'x'],
    ['baseUrl', 200, ''],
  ];

  it.each(overLong)('bounds %s at %i characters', (field, max, filler) => {
    const value =
      field === 'baseUrl' ? `https://evo.example.com/${'a'.repeat(max + 1 - 24)}` : filler.repeat(max + 1);
    expect(value.length).toBeGreaterThan(max);
    const result = whatsappConnectSchema.safeParse({ ...EVOLUTION, [field]: value });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === field && i.code === 'too_big')).toBe(true);
    }
  });

  it('rejects an unknown provider', () => {
    expect(whatsappConnectSchema.safeParse({ ...EVOLUTION, provider: 'twilio' }).success).toBe(false);
  });
});

describe('whatsappNumberUpdateSchema', () => {
  it('accepts connected and disabled', () => {
    expect(whatsappNumberUpdateSchema.parse({ status: 'connected' }).status).toBe('connected');
    expect(whatsappNumberUpdateSchema.parse({ status: 'disabled' }).status).toBe('disabled');
  });

  it('rejects pending — that state is set by the connection flow, not by an owner', () => {
    expect(whatsappNumberUpdateSchema.safeParse({ status: 'pending' }).success).toBe(false);
  });

  it('rejects a missing status', () => {
    expect(whatsappNumberUpdateSchema.safeParse({}).success).toBe(false);
  });
});
