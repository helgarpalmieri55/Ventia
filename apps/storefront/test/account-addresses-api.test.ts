import { describe, expect, it, vi } from 'vitest';
import {
  AccountApiError,
  createAddress,
  deleteAddress,
  fetchDefaultAddress,
  fetchMyAddresses,
  setDefaultAddress,
  updateAddress,
  type CheckoutAddress,
  type SavedAddress,
} from '../lib/account-api';

// The saved-address half of `account-api.ts`, tested the same way the rest of
// that module is: a mocked `fetchImpl` asserting path, method, body and
// credentials, with no network.

const ADDRESS: CheckoutAddress = {
  nombreCompleto: 'Ana María Gómez',
  telefono: '3001234567',
  departamentoCode: '05',
  municipioName: 'Medellín',
  direccion: 'Calle 10 # 20-30',
};

const SAVED: SavedAddress = {
  id: '11111111-1111-4111-8111-111111111111',
  label: 'Casa',
  address: ADDRESS,
  isDefault: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function ok(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

function noContent() {
  return vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
}

function failing(status: number, code: string) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: code }), { status }));
}

function bodyOf(fetchImpl: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string) as Record<string, unknown>;
}

describe('fetchMyAddresses', () => {
  it('GETs the addresses path with credentials and unwraps `addresses`', async () => {
    const fetchImpl = ok({ addresses: [SAVED] });
    await expect(fetchMyAddresses(fetchImpl)).resolves.toEqual([SAVED]);
    expect(fetchImpl).toHaveBeenCalledWith('/api/account/addresses', {
      method: 'GET',
      credentials: 'include',
    });
  });

  it('keeps the API ordering — default first is what checkout pre-fills from', async () => {
    const other = { ...SAVED, id: 'b', isDefault: false };
    const rows = await fetchMyAddresses(ok({ addresses: [SAVED, other] }));
    expect(rows.map((r) => r.id)).toEqual([SAVED.id, 'b']);
  });
});

describe('fetchDefaultAddress', () => {
  it('picks the row flagged default rather than simply the first', async () => {
    const first = { ...SAVED, id: 'a', isDefault: false };
    const theDefault = { ...SAVED, id: 'b', isDefault: true };
    await expect(fetchDefaultAddress(ok({ addresses: [first, theDefault] }))).resolves.toEqual(theDefault);
  });

  it('answers null when the shopper has addresses but no default', async () => {
    // Deleting the default does NOT promote another on the API, so this is a
    // real state — and checkout must pre-fill nothing rather than guess.
    const rows = [{ ...SAVED, isDefault: false }];
    await expect(fetchDefaultAddress(ok({ addresses: rows }))).resolves.toBeNull();
  });

  it('answers null for an empty list', async () => {
    await expect(fetchDefaultAddress(ok({ addresses: [] }))).resolves.toBeNull();
  });

  it('answers null instead of throwing when the session expired', async () => {
    // Checkout calls this believing the shopper is signed in, on the strength
    // of a `/me` answered minutes earlier. A session that lapsed in between
    // must leave guest checkout completely untouched.
    await expect(fetchDefaultAddress(failing(401, 'SHOPPER_UNAUTHORIZED'))).resolves.toBeNull();
  });

  it('still throws on a genuine fault', async () => {
    await expect(fetchDefaultAddress(failing(500, 'UNKNOWN'))).rejects.toBeInstanceOf(AccountApiError);
  });
});

describe('createAddress', () => {
  it('POSTs the address with credentials included', async () => {
    const fetchImpl = ok(SAVED, 201);
    await expect(createAddress({ address: ADDRESS }, fetchImpl)).resolves.toEqual(SAVED);
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/account/addresses');
    expect((fetchImpl.mock.calls[0][1] as RequestInit).method).toBe('POST');
    expect((fetchImpl.mock.calls[0][1] as RequestInit).credentials).toBe('include');
  });

  it('omits a blank label rather than sending an empty string', async () => {
    // The API's schema is `min(1).optional()`: `''` is a 400, an absent key
    // is the intended "didn't say".
    const fetchImpl = ok(SAVED, 201);
    await createAddress({ label: '', address: ADDRESS }, fetchImpl);
    expect(Object.keys(bodyOf(fetchImpl))).not.toContain('label');
  });

  it('sends a label the shopper actually gave', async () => {
    const fetchImpl = ok(SAVED, 201);
    await createAddress({ label: 'Oficina', address: ADDRESS }, fetchImpl);
    expect(bodyOf(fetchImpl).label).toBe('Oficina');
  });

  it('omits isDefault entirely when it was not asked for', async () => {
    const fetchImpl = ok(SAVED, 201);
    await createAddress({ address: ADDRESS }, fetchImpl);
    expect(Object.keys(bodyOf(fetchImpl))).not.toContain('isDefault');
  });

  it('sends isDefault when it was', async () => {
    const fetchImpl = ok(SAVED, 201);
    await createAddress({ address: ADDRESS, isDefault: true }, fetchImpl);
    expect(bodyOf(fetchImpl).isDefault).toBe(true);
  });

  it('surfaces TOO_MANY_ADDRESSES as a code the UI can explain', async () => {
    await expect(createAddress({ address: ADDRESS }, failing(409, 'TOO_MANY_ADDRESSES'))).rejects.toMatchObject({
      status: 409,
      code: 'TOO_MANY_ADDRESSES',
    });
  });
});

describe('updateAddress', () => {
  it('PATCHes the address by id with credentials included', async () => {
    const fetchImpl = ok(SAVED);
    await updateAddress(SAVED.id, { address: ADDRESS }, fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toBe(`/api/account/addresses/${SAVED.id}`);
    expect((fetchImpl.mock.calls[0][1] as RequestInit).method).toBe('PATCH');
    expect((fetchImpl.mock.calls[0][1] as RequestInit).credentials).toBe('include');
  });

  it('sends the address whole, never a partial merge', async () => {
    // A merged partial could produce a municipio that no longer belongs to
    // its departamento — the one rule the address schema exists to enforce.
    const fetchImpl = ok(SAVED);
    await updateAddress(SAVED.id, { address: ADDRESS }, fetchImpl);
    expect(bodyOf(fetchImpl).address).toEqual(ADDRESS);
  });

  it('sends label: null to clear it, distinct from omitting the key', async () => {
    const cleared = ok(SAVED);
    await updateAddress(SAVED.id, { label: null, address: ADDRESS }, cleared);
    expect(bodyOf(cleared).label).toBeNull();

    const untouched = ok(SAVED);
    await updateAddress(SAVED.id, { address: ADDRESS }, untouched);
    expect(Object.keys(bodyOf(untouched))).not.toContain('label');
  });

  it('surfaces ADDRESS_NOT_FOUND — the same answer a stranger’s id gets', async () => {
    await expect(updateAddress(SAVED.id, { address: ADDRESS }, failing(404, 'ADDRESS_NOT_FOUND'))).rejects.toMatchObject(
      { code: 'ADDRESS_NOT_FOUND' },
    );
  });
});

describe('setDefaultAddress', () => {
  it('POSTs to the default sub-path and returns the promoted row', async () => {
    const fetchImpl = ok(SAVED);
    await expect(setDefaultAddress(SAVED.id, fetchImpl)).resolves.toEqual(SAVED);
    expect(fetchImpl).toHaveBeenCalledWith(`/api/account/addresses/${SAVED.id}/default`, {
      method: 'POST',
      credentials: 'include',
    });
  });

  it('sends no body — this promotes a row that already exists', async () => {
    const fetchImpl = ok(SAVED);
    await setDefaultAddress(SAVED.id, fetchImpl);
    expect((fetchImpl.mock.calls[0][1] as RequestInit).body).toBeUndefined();
  });
});

describe('deleteAddress', () => {
  it('DELETEs by id with credentials included', async () => {
    const fetchImpl = noContent();
    await deleteAddress(SAVED.id, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(`/api/account/addresses/${SAVED.id}`, {
      method: 'DELETE',
      credentials: 'include',
    });
  });

  it('resolves on the 204 without trying to parse a body', async () => {
    await expect(deleteAddress(SAVED.id, noContent())).resolves.toBeUndefined();
  });

  it('encodes the id rather than interpolating it raw into the path', async () => {
    const fetchImpl = noContent();
    await deleteAddress('a/../b', fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/account/addresses/a%2F..%2Fb');
  });

  it('still throws with the API code on a failure', async () => {
    await expect(deleteAddress(SAVED.id, failing(404, 'ADDRESS_NOT_FOUND'))).rejects.toMatchObject({
      status: 404,
      code: 'ADDRESS_NOT_FOUND',
    });
  });
});
