import { describe, expect, it } from 'vitest';
import { confirmationPathFor, decideEpaycoRetorno, pickRefPayco } from '../lib/epayco-retorno';

/** Unit tests for the ePayco response page's PURE decision logic, extracted
 * out of `app/pago/epayco-retorno/[orderNumber]/page.tsx` for the same reason
 * `wompi-retorno.test.ts` exists: this app has no React Testing Library, so the
 * branchy part lives in a pure `lib/` helper and that is what gets tested. */

describe('pickRefPayco', () => {
  // ePayco's OWN Angular sample reads `params['ref_payco'] || params['x_ref_payco']`
  // (github.com/epayco/resources, epayco-ng6 response.component.ts), and its
  // `onePage/response/response.html` sample reads `getQueryParam('ref_payco')`.
  // Both spellings are therefore accepted, `ref_payco` first.
  it('prefers ref_payco', () => {
    expect(pickRefPayco('123456789', 'other')).toBe('123456789');
  });

  it('falls back to x_ref_payco when ref_payco is absent', () => {
    expect(pickRefPayco(null, '987654321')).toBe('987654321');
    expect(pickRefPayco(undefined, '987654321')).toBe('987654321');
  });

  it('treats blank-after-trim as absent on both spellings', () => {
    expect(pickRefPayco('   ', '987654321')).toBe('987654321');
    expect(pickRefPayco('', '')).toBeNull();
    expect(pickRefPayco('   ', '   ')).toBeNull();
    expect(pickRefPayco(null, undefined)).toBeNull();
  });

  it('trims the value it returns', () => {
    expect(pickRefPayco(' 123456789 ', null)).toBe('123456789');
    expect(pickRefPayco(null, ' 987654321 ')).toBe('987654321');
  });
});

describe('decideEpaycoRetorno', () => {
  it('order number and ref_payco present -> navigate AND send the hint', () => {
    expect(decideEpaycoRetorno('1042', '123456789')).toEqual({
      kind: 'navigate-with-hint',
      orderNumber: '1042',
      providerRef: '123456789',
      confirmationPath: '/checkout/confirmacion/1042',
    });
  });

  it('accepts the x_ref_payco spelling too', () => {
    expect(decideEpaycoRetorno('1042', null, '123456789')).toEqual({
      kind: 'navigate-with-hint',
      orderNumber: '1042',
      providerRef: '123456789',
      confirmationPath: '/checkout/confirmacion/1042',
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace only', '   '],
  ])('order number but NO usable ref (%s) -> navigate, skip the PATCH entirely', (_label, ref) => {
    // Sending a PATCH with an empty providerRef would just 400 at the API — a
    // guaranteed-useless request on the shopper's critical path.
    expect(decideEpaycoRetorno('1042', ref)).toEqual({
      kind: 'navigate',
      orderNumber: '1042',
      confirmationPath: '/checkout/confirmacion/1042',
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace only', '   '],
  ])('no usable order number (%s) -> error branch, regardless of ref', (_label, orderNumber) => {
    expect(decideEpaycoRetorno(orderNumber, '123456789')).toEqual({ kind: 'error' });
  });

  it('trims surrounding whitespace off both values before using them', () => {
    expect(decideEpaycoRetorno(' 1042 ', ' 123456789 ')).toEqual({
      kind: 'navigate-with-hint',
      orderNumber: '1042',
      providerRef: '123456789',
      confirmationPath: '/checkout/confirmacion/1042',
    });
  });

  it('percent-encodes the order number into the confirmation path (never interpolated raw)', () => {
    expect(decideEpaycoRetorno('a/b', '123456789')).toMatchObject({
      confirmationPath: '/checkout/confirmacion/a%2Fb',
    });
  });
});

describe('confirmationPathFor', () => {
  it('builds the same confirmation path every other payment page uses', () => {
    expect(confirmationPathFor('1042')).toBe('/checkout/confirmacion/1042');
  });

  it('encodes URL-significant characters', () => {
    expect(confirmationPathFor('a b/c')).toBe('/checkout/confirmacion/a%20b%2Fc');
  });
});

/** Regression test for why the order number rides in the PATH rather than a
 * query param — the same reasoning as the Wompi return page's, applied to
 * ePayco's own append.
 *
 * ePayco appends `?ref_payco=...` to whatever `response` URL it was given (its
 * own `onePage/response/response.html` sample reads exactly that query param),
 * and no ePayco doc states what happens when the URL already carries a query
 * string. */
describe("ePayco's ?ref_payco= append onto the response URL", () => {
  const BASE = 'https://tienda.example.com';

  it('path-based URL: both order number and ref come back extractable', () => {
    const responseUrl = `${BASE}/pago/epayco-retorno/1042`;
    const returned = new URL(`${responseUrl}?ref_payco=123456789`);

    expect(returned.pathname.split('/').pop()).toBe('1042');
    expect(returned.searchParams.get('ref_payco')).toBe('123456789');
    // Exactly one query param — nothing to mis-split.
    expect([...returned.searchParams.keys()]).toEqual(['ref_payco']);

    expect(decideEpaycoRetorno(returned.pathname.split('/').pop(), returned.searchParams.get('ref_payco'))).toEqual({
      kind: 'navigate-with-hint',
      orderNumber: '1042',
      providerRef: '123456789',
      confirmationPath: '/checkout/confirmacion/1042',
    });
  });

  it('demonstrates what a query-param-carried order number would have done instead', () => {
    // `.../epayco-retorno?orderNumber=1042` + `?ref_payco=...` parses as ONE
    // param whose value swallows the ref — breaking both values at once.
    const broken = new URL(`${BASE}/pago/epayco-retorno?orderNumber=1042?ref_payco=123456789`);
    expect(broken.searchParams.get('orderNumber')).toBe('1042?ref_payco=123456789');
    expect(broken.searchParams.get('ref_payco')).toBeNull();
  });
});

/** Per-tenant response URLs — the storefront-side statement of the same
 * property `packages/payments`' adapter tests assert: two tenants' shoppers
 * come back to two different storefronts, and this route parses either one
 * identically. */
describe('two tenants, two different response URLs', () => {
  it('parses each tenant’s own response URL into the same decision', () => {
    const a = new URL('https://tienda-a.example.com/pago/epayco-retorno/1?ref_payco=111');
    const b = new URL('http://demo-moda.ventia.localhost/pago/epayco-retorno/1?ref_payco=222');

    expect(a.host).not.toBe(b.host);
    expect(a.pathname).toBe(b.pathname);

    expect(decideEpaycoRetorno(a.pathname.split('/').pop(), a.searchParams.get('ref_payco'))).toMatchObject({
      kind: 'navigate-with-hint',
      providerRef: '111',
    });
    expect(decideEpaycoRetorno(b.pathname.split('/').pop(), b.searchParams.get('ref_payco'))).toMatchObject({
      kind: 'navigate-with-hint',
      providerRef: '222',
    });
  });
});
