import { describe, expect, it } from 'vitest';
import {
  BLANK_WHATSAPP_FORM,
  buildWhatsAppConnectPayload,
  whatsappCallbackUrl,
  whatsappStatusLabel,
  type WhatsAppFormFields,
} from '../lib/whatsapp-api';

/** A form where BOTH providers' fields have been filled — what actually
 * happens when a merchant tries Cloud, gets stuck, switches the picker to
 * Evolution and submits. Every assertion below about "the other provider's
 * fields are absent" is checked against this, not against a form where they
 * happen to be blank. */
const bothFilled: WhatsAppFormFields = {
  provider: 'cloud',
  displayPhone: '300 123 4567',
  phoneNumberId: '123456789012345',
  accessToken: 'EAAG-cloud-token',
  appSecret: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
  verifyToken: 'mi-token-secreto',
  instanceName: 'mi-tienda',
  apiKey: 'evolution-api-key',
  baseUrl: 'https://evolution.tudominio.com',
};

describe('buildWhatsAppConnectPayload', () => {
  it('sends only the Cloud branch of the discriminated union', () => {
    expect(buildWhatsAppConnectPayload(bothFilled)).toEqual({
      provider: 'cloud',
      phoneNumberId: '123456789012345',
      accessToken: 'EAAG-cloud-token',
      appSecret: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
      verifyToken: 'mi-token-secreto',
      displayPhone: '300 123 4567',
    });
  });

  it('never puts the Evolution secrets on the wire for a Cloud connection', () => {
    const payload = buildWhatsAppConnectPayload(bothFilled);
    expect(payload).not.toHaveProperty('apiKey');
    expect(payload).not.toHaveProperty('baseUrl');
    expect(payload).not.toHaveProperty('instanceName');
  });

  it('sends only the Evolution branch of the discriminated union', () => {
    expect(buildWhatsAppConnectPayload({ ...bothFilled, provider: 'evolution' })).toEqual({
      provider: 'evolution',
      instanceName: 'mi-tienda',
      apiKey: 'evolution-api-key',
      baseUrl: 'https://evolution.tudominio.com',
      displayPhone: '300 123 4567',
    });
  });

  it('never puts the Meta credentials on the wire for an Evolution connection', () => {
    const payload = buildWhatsAppConnectPayload({ ...bothFilled, provider: 'evolution' });
    expect(payload).not.toHaveProperty('accessToken');
    expect(payload).not.toHaveProperty('appSecret');
    expect(payload).not.toHaveProperty('verifyToken');
    expect(payload).not.toHaveProperty('phoneNumberId');
  });

  it('leaves values exactly as typed — the server trims and normalizes displayPhone', () => {
    const payload = buildWhatsAppConnectPayload({ ...bothFilled, displayPhone: ' +57 300 123 4567 ' });
    expect(payload.displayPhone).toBe(' +57 300 123 4567 ');
  });

  it('defaults a blank form to the Cloud branch', () => {
    expect(buildWhatsAppConnectPayload(BLANK_WHATSAPP_FORM).provider).toBe('cloud');
  });
});

describe('whatsappCallbackUrl', () => {
  const base = 'https://api.mitienda.com/webhooks/whatsapp';

  it("appends the ?number= param Meta's GET handshake needs to attribute a verification", () => {
    expect(whatsappCallbackUrl(base, 'cloud', '123456789012345')).toBe(
      'https://api.mitienda.com/webhooks/whatsapp/cloud?number=123456789012345',
    );
  });

  it('does not add a query param for Evolution, whose payload names its own instance', () => {
    expect(whatsappCallbackUrl(base, 'evolution', 'mi-tienda')).toBe(
      'https://api.mitienda.com/webhooks/whatsapp/evolution',
    );
  });

  it('tolerates a trailing slash on the base URL instead of emitting a double slash', () => {
    expect(whatsappCallbackUrl(`${base}//`, 'cloud', '123456789012345')).toBe(
      'https://api.mitienda.com/webhooks/whatsapp/cloud?number=123456789012345',
    );
  });

  it('escapes the id rather than pasting it raw into the query string', () => {
    expect(whatsappCallbackUrl(base, 'cloud', 'a b&c')).toBe(
      'https://api.mitienda.com/webhooks/whatsapp/cloud?number=a%20b%26c',
    );
  });

  it('returns null for a Cloud URL with no phone number ID, so half a URL is never shown as copyable', () => {
    expect(whatsappCallbackUrl(base, 'cloud', '')).toBeNull();
    expect(whatsappCallbackUrl(base, 'cloud', '   ')).toBeNull();
  });

  it('returns null when the API did not report a base URL at all', () => {
    expect(whatsappCallbackUrl('', 'cloud', '123456789012345')).toBeNull();
    expect(whatsappCallbackUrl('', 'evolution', 'mi-tienda')).toBeNull();
  });
});

describe('whatsappStatusLabel', () => {
  it('labels the three statuses the column can hold, including pending', () => {
    expect(whatsappStatusLabel('connected')).toBe('Conectado');
    expect(whatsappStatusLabel('disabled')).toBe('Desactivado');
    expect(whatsappStatusLabel('pending')).toBe('Pendiente de verificar');
  });

  it('falls back to the raw value for an unknown status, which is what a merchant would quote to support', () => {
    expect(whatsappStatusLabel('something_new')).toBe('something_new');
  });
});
