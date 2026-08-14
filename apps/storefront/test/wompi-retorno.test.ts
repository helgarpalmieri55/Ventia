import { describe, expect, it } from 'vitest';
import { decideWompiRetorno, confirmationPathFor } from '../lib/wompi-retorno';

/** Unit tests for the Wompi return page's PURE decision logic, extracted out
 * of `app/pago/wompi-retorno/[orderNumber]/page.tsx` deliberately: this app
 * has no React Testing Library, and the established convention here (P2b
 * Task 7's precedent, and `checkout-form.ts`/`checkout-form.test.ts`) is to
 * test the extracted pure helper rather than the component. */

describe('decideWompiRetorno', () => {
  it('both orderNumber and id present -> navigate AND send the hint', () => {
    expect(decideWompiRetorno('1042', '01-1531231271-19365')).toEqual({
      kind: 'navigate-with-hint',
      orderNumber: '1042',
      providerRef: '01-1531231271-19365',
      confirmationPath: '/checkout/confirmacion/1042',
    });
  });

  it('orderNumber but NO id -> navigate, and skip the PATCH entirely', () => {
    // Sending a PATCH with an empty providerRef would just 400 at the API —
    // a guaranteed-useless request on the shopper's critical path.
    expect(decideWompiRetorno('1042', null)).toEqual({
      kind: 'navigate',
      orderNumber: '1042',
      confirmationPath: '/checkout/confirmacion/1042',
    });
  });

  it.each([
    ['an undefined id', undefined],
    ['an empty-string id', ''],
    ['a whitespace-only id', '   '],
  ])('%s is treated as no id at all (navigate, no PATCH)', (_label, id) => {
    expect(decideWompiRetorno('1042', id)).toEqual({
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
  ])('no usable orderNumber (%s) -> error branch, regardless of id', (_label, orderNumber) => {
    expect(decideWompiRetorno(orderNumber, 'txn-abc')).toEqual({ kind: 'error' });
  });

  it('trims surrounding whitespace off both values before using them', () => {
    expect(decideWompiRetorno(' 1042 ', ' txn-abc ')).toEqual({
      kind: 'navigate-with-hint',
      orderNumber: '1042',
      providerRef: 'txn-abc',
      confirmationPath: '/checkout/confirmacion/1042',
    });
  });

  it('percent-encodes the order number into the confirmation path (never interpolated raw)', () => {
    const decision = decideWompiRetorno('a/b', 'txn-abc');
    expect(decision).toMatchObject({ confirmationPath: '/checkout/confirmacion/a%2Fb' });
  });
});

describe('confirmationPathFor', () => {
  it('builds the same confirmation path the ePayco bridge page uses', () => {
    expect(confirmationPathFor('1042')).toBe('/checkout/confirmacion/1042');
  });

  it('encodes URL-significant characters', () => {
    expect(confirmationPathFor('a b/c')).toBe('/checkout/confirmacion/a%20b%2Fc');
  });
});

/** THE regression test for the whole reason the order number rides in the
 * PATH rather than a query param (P3c Task 2, requirement 3).
 *
 * Wompi appends `?id={transactionId}` to whatever `redirect-url` it was
 * given, and its docs only ever show that appended onto a URL with NO
 * existing query string — nothing documents whether it checks for an
 * existing `?`. This proves the path-based URL survives that append with
 * BOTH values still independently extractable, and demonstrates concretely
 * what the query-param shape would have done instead. */
describe("Wompi's ?id= append onto the redirect-url", () => {
  const BASE = 'https://tienda.example.com';

  it('path-based URL: both orderNumber and id come back extractable', () => {
    const redirectUrl = `${BASE}/pago/wompi-retorno/1042`;
    const returned = new URL(`${redirectUrl}?id=01-1531231271-19365`);

    const orderNumber = returned.pathname.split('/').pop();
    const id = returned.searchParams.get('id');

    expect(orderNumber).toBe('1042');
    expect(id).toBe('01-1531231271-19365');
    // Exactly one query param — nothing to mis-split.
    expect([...returned.searchParams.keys()]).toEqual(['id']);

    // And the page's own decision logic accepts that pair.
    expect(decideWompiRetorno(orderNumber, id)).toEqual({
      kind: 'navigate-with-hint',
      orderNumber: '1042',
      providerRef: '01-1531231271-19365',
      confirmationPath: '/checkout/confirmacion/1042',
    });
  });

  it('query-param URL (the REJECTED shape): a naive append silently fuses both values into one param', () => {
    // This is the failure mode requirement 3 exists to avoid — asserted
    // here so the reasoning is executable rather than a claim in a comment.
    const rejectedRedirectUrl = `${BASE}/pago/wompi-retorno?orderNumber=1042`;
    const returned = new URL(`${rejectedRedirectUrl}?id=01-1531231271-19365`);

    expect(returned.searchParams.get('orderNumber')).toBe('1042?id=01-1531231271-19365');
    expect(returned.searchParams.get('id')).toBeNull();
    expect([...returned.searchParams.keys()]).toEqual(['orderNumber']);

    // Fed to the same decision logic, that produces a nonsense order number
    // and no provider ref — i.e. a broken confirmation link AND a lost hint.
    expect(decideWompiRetorno(returned.searchParams.get('orderNumber'), returned.searchParams.get('id'))).toEqual({
      kind: 'navigate',
      orderNumber: '1042?id=01-1531231271-19365',
      confirmationPath: '/checkout/confirmacion/1042%3Fid%3D01-1531231271-19365',
    });
  });
});
