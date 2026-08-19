import { describe, expect, it } from 'vitest';
import { ANON_NAME, ANON_PHONE, ANON_REDACTED, isAnonymizedValue } from '@ventia/core';
import { PII_KEYS, anonymizeAddress, buildRedactor, isAnonymizedAddress, phoneDigits } from '../src/privacy/redact';

describe('buildRedactor — by key', () => {
  const redact = buildRedactor([]);

  it('blanks a scalar under a known PII key even with no secrets to match', () => {
    expect(redact({ customer_email: 'ana@correo.co', status: 'APPROVED' })).toEqual({
      customer_email: ANON_REDACTED,
      status: 'APPROVED',
    });
  });

  it('normalizes key casing and separators, so customer_email / customerEmail / Customer-Email all match', () => {
    expect(redact({ customerEmail: 'a@b.co' })).toEqual({ customerEmail: ANON_REDACTED });
    expect(redact({ 'Customer-Email': 'a@b.co' })).toEqual({ 'Customer-Email': ANON_REDACTED });
  });

  it('matches keys exactly, so a product name snapshot is NOT collateral damage', () => {
    // The merchant's catalog is not the shopper's personal data. A substring
    // rule on "name" would destroy this.
    expect(redact({ nameSnapshot: 'Camiseta azul', providerName: 'wompi' })).toEqual({
      nameSnapshot: 'Camiseta azul',
      providerName: 'wompi',
    });
    expect(PII_KEYS.has('namesnapshot')).toBe(false);
  });

  it('keeps departamento and municipio: aggregate geography is not personal data (SPEC §9)', () => {
    expect(PII_KEYS.has('departamentoname')).toBe(false);
    expect(PII_KEYS.has('municipioname')).toBe(false);
    expect(redact({ departamentoName: 'Antioquia', municipioName: 'Medellín', direccion: 'Cra 1 # 2-3' })).toEqual({
      departamentoName: 'Antioquia',
      municipioName: 'Medellín',
      direccion: ANON_REDACTED,
    });
  });

  it('walks nested structure under a PII key rather than blanking the whole subtree', () => {
    expect(
      redact({ address: { departamentoName: 'Antioquia', direccion: 'Cra 1', telefono: '3001112233' } }),
    ).toEqual({ address: { departamentoName: 'Antioquia', direccion: ANON_REDACTED, telefono: ANON_REDACTED } });
  });

  it('leaves numbers, booleans and nulls alone — every amount survives', () => {
    expect(redact({ amount_in_cents: 4_590_000, approved: true, providerRef: null })).toEqual({
      amount_in_cents: 4_590_000,
      approved: true,
      providerRef: null,
    });
  });
});

describe('buildRedactor — by value', () => {
  it('replaces a secret wherever it appears in free text under an innocent key', () => {
    const redact = buildRedactor(['Ana Gómez', 'ana@correo.co']);
    expect(redact({ reason: 'Ana Gómez pidió cancelar, escribir a ana@correo.co' })).toEqual({
      reason: `${ANON_REDACTED} pidió cancelar, escribir a ${ANON_REDACTED}`,
    });
  });

  it('replaces an exact match of ANY length, but only substring-matches longer secrets', () => {
    const redact = buildRedactor(['Ana']);
    // Exact whole-value match: replaced.
    expect(redact({ note: 'Ana' })).toEqual({ note: ANON_REDACTED });
    // Too short to shred substrings out of unrelated words like "Analizar".
    expect(redact({ note: 'Analizar el pedido' })).toEqual({ note: 'Analizar el pedido' });
  });

  it('replaces the longest secret first so no fragment is orphaned', () => {
    const redact = buildRedactor(['Gómez', 'Ana Gómez']);
    expect(redact({ note: 'Cliente Ana Gómez' })).toEqual({ note: `Cliente ${ANON_REDACTED}` });
  });

  it('is idempotent: running it on its own output changes nothing', () => {
    const redact = buildRedactor(['Ana Gómez']);
    const once = redact({ reason: 'Ana Gómez no contesta', email: 'ana@correo.co' });
    // A second run models the real second pass, whose secret set is empty
    // because every stored value is now a sentinel.
    expect(buildRedactor([])(once)).toEqual(once);
  });

  it('preserves key order so an unchanged object serializes identically', () => {
    const input = { b: 'uno', a: 'dos', c: 3 };
    expect(JSON.stringify(buildRedactor([])(input))).toBe(JSON.stringify(input));
  });
});

describe('anonymizeAddress', () => {
  const address = {
    nombreCompleto: 'Ana Gómez',
    telefono: '3001112233',
    departamentoCode: '05',
    departamentoName: 'Antioquia',
    municipioName: 'Medellín',
    direccion: 'Carrera 7 # 45-19',
    complemento: 'Apto 502',
    barrio: 'El Poblado',
    notas: 'Dejar con el portero',
  };

  it('keeps departamento and municipio, replaces the person, drops everything street-level', () => {
    expect(anonymizeAddress(address)).toEqual({
      departamentoCode: '05',
      departamentoName: 'Antioquia',
      municipioName: 'Medellín',
      nombreCompleto: ANON_NAME,
      telefono: ANON_PHONE,
      direccion: 'Dirección eliminada',
    });
  });

  it('drops UNKNOWN keys rather than keeping them: an unreviewed field is where PII hides', () => {
    const out = anonymizeAddress({ ...address, campoNuevo: 'cédula 1020304050' });
    expect(out.campoNuevo).toBeUndefined();
  });

  it('produces a valid result for a missing or malformed address column', () => {
    for (const input of [null, undefined, 'nope', 42, []]) {
      const out = anonymizeAddress(input);
      expect(out.nombreCompleto).toBe(ANON_NAME);
      expect(out.telefono).toBe(ANON_PHONE);
      expect(isAnonymizedAddress(out)).toBe(true);
    }
  });

  it('is idempotent', () => {
    const once = anonymizeAddress(address);
    expect(anonymizeAddress(once)).toEqual(once);
  });
});

describe('sentinels', () => {
  it('recognizes its own output, which is what makes the whole flow a no-op on re-run', () => {
    expect(isAnonymizedValue(ANON_NAME)).toBe(true);
    expect(isAnonymizedValue(ANON_PHONE)).toBe(true);
    expect(isAnonymizedValue(ANON_REDACTED)).toBe(true);
    expect(isAnonymizedValue('anon-4f3b@anonimizado.invalid')).toBe(true);
    expect(isAnonymizedValue('ana@correo.co')).toBe(false);
    expect(isAnonymizedValue(null)).toBe(false);
  });
});

describe('phoneDigits', () => {
  it('matches packages/whatsapp normalizePhone, so a shopperRef and a checkout phone collapse to the same digits', () => {
    expect(phoneDigits('573001112233@s.whatsapp.net')).toBe('573001112233');
    expect(phoneDigits('+57 300 111 2233')).toBe('573001112233');
  });
});
