import { describe, expect, it, vi } from 'vitest';
import { CheckoutApiError, fetchShippingQuote, submitCheckout } from '../lib/checkout-api';

// Matching cart-api.test.ts's established precedent for this exact kind of
// client (mocked-fetchImpl unit tests asserting the right proxy path/
// method/body), not explicitly required by the task brief's own test list
// but added for parity across every client API module in this app.

describe('fetchShippingQuote', () => {
  it('GETs the proxy shipping-quote path with the departamento query param and credentials included', async () => {
    const lines = [{ id: 'flat-1', type: 'flat', label: 'Envío estándar', priceCents: 12000 }];
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(lines), { status: 200 }));
    const result = await fetchShippingQuote('05', fetchImpl);
    expect(result).toEqual(lines);
    expect(fetchImpl).toHaveBeenCalledWith('/api/checkout/shipping-quote?departamento=05', {
      method: 'GET',
      credentials: 'include',
    });
  });

  it('throws a CheckoutApiError with the parsed code and details on a non-2xx response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'VALIDATION_FAILED', details: { departamento: 'inválido' } }), {
          status: 400,
        }),
      );
    const err = await fetchShippingQuote('00', fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(CheckoutApiError);
    expect((err as CheckoutApiError).status).toBe(400);
    expect((err as CheckoutApiError).code).toBe('VALIDATION_FAILED');
    expect((err as CheckoutApiError).details).toEqual({ departamento: 'inválido' });
  });
});

describe('submitCheckout', () => {
  const input = {
    email: 'shopper@example.com',
    phone: '3001234567',
    address: {
      nombreCompleto: 'Ana María Gómez',
      telefono: '3001234567',
      departamentoCode: '05',
      municipioName: 'Medellín',
      direccion: 'Calle 10 # 20-30',
    },
    shippingMethodId: 'flat-1',
    paymentMethod: 'cod' as const,
  };

  it('POSTs to /api/checkout with the body and credentials included', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ orderNumber: 42, totalCents: 100000 }), { status: 201 }));
    const result = await submitCheckout(input, fetchImpl);
    expect(result).toEqual({ orderNumber: 42, totalCents: 100000 });
    expect(fetchImpl).toHaveBeenCalledWith('/api/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      credentials: 'include',
    });
  });

  it('surfaces a CART_EMPTY 400 as a CheckoutApiError with that code', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'CART_EMPTY' }), { status: 400 }));
    const err = await submitCheckout(input, fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(CheckoutApiError);
    expect((err as CheckoutApiError).code).toBe('CART_EMPTY');
  });

  it('surfaces an INSUFFICIENT_STOCK 400 with productId/available in details', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'INSUFFICIENT_STOCK', details: { productId: 'p1', available: 2 } }),
        { status: 400 },
      ),
    );
    const err = await submitCheckout(input, fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(CheckoutApiError);
    expect((err as CheckoutApiError).code).toBe('INSUFFICIENT_STOCK');
    expect((err as CheckoutApiError).details).toEqual({ productId: 'p1', available: 2 });
  });

  it('falls back to code UNKNOWN for an unparseable error body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not json', { status: 500 }));
    const err = await submitCheckout(input, fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(CheckoutApiError);
    expect((err as CheckoutApiError).code).toBe('UNKNOWN');
  });

  it('passes a wompi paymentMethod through in the request body and round-trips redirectUrl from the response', async () => {
    const wompiInput = { ...input, paymentMethod: 'wompi' as const };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          orderNumber: 43,
          totalCents: 100000,
          redirectUrl: 'https://checkout.wompi.co/p/?public-key=pub_test_x&signature:integrity=abc',
        }),
        { status: 201 },
      ),
    );
    const result = await submitCheckout(wompiInput, fetchImpl);
    expect(result).toEqual({
      orderNumber: 43,
      totalCents: 100000,
      redirectUrl: 'https://checkout.wompi.co/p/?public-key=pub_test_x&signature:integrity=abc',
    });
    expect(fetchImpl).toHaveBeenCalledWith('/api/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(wompiInput),
      credentials: 'include',
    });
  });
});
