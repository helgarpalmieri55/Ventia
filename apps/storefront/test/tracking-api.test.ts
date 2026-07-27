import { describe, expect, it, vi } from 'vitest';
import { TrackingApiError, trackOrder, type OrderTracking } from '../lib/tracking-api';

const sampleTracking: OrderTracking = {
  orderNumber: 1042,
  status: 'SHIPPED',
  createdAt: '2026-01-01T00:00:00.000Z',
  items: [{ nameSnapshot: 'Camiseta', qty: 2, priceCentsSnapshot: 5000 }],
  totalCents: 10000,
  shippingCiudad: 'Medellín',
  shippingDepartamento: 'Antioquia',
  shipment: { carrier: 'Servientrega', trackingNumber: 'SV-123' },
  events: [
    { type: 'created', createdAt: '2026-01-01T00:00:00.000Z' },
    { type: 'status_changed', createdAt: '2026-01-02T00:00:00.000Z' },
  ],
};

describe('trackOrder', () => {
  it('GETs the proxy path with the orderNumber and contact query params encoded', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(sampleTracking), { status: 200 }));
    const result = await trackOrder('1042', 'shopper@example.com', fetchImpl);
    expect(result).toEqual(sampleTracking);
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/orders/track?orderNumber=1042&contact=shopper%40example.com',
      { method: 'GET' },
    );
  });

  it('encodes special characters in both params', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(sampleTracking), { status: 200 }));
    await trackOrder('10 42', '+57 300/123', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      `/api/orders/track?orderNumber=${encodeURIComponent('10 42')}&contact=${encodeURIComponent('+57 300/123')}`,
      { method: 'GET' },
    );
  });

  it('throws TrackingApiError with the status and body on a 404 ORDER_NOT_FOUND response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: 'ORDER_NOT_FOUND' }), { status: 404 }));
    const err = await trackOrder('9999', 'nobody@example.com', fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(TrackingApiError);
    expect((err as TrackingApiError).status).toBe(404);
    expect((err as TrackingApiError).body).toContain('ORDER_NOT_FOUND');
  });

  it('throws TrackingApiError with the status and body on a 400 VALIDATION_FAILED response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'VALIDATION_FAILED', details: { contact: 'contact es requerido' } }), {
          status: 400,
        }),
      );
    const err = await trackOrder('1042', '', fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(TrackingApiError);
    expect((err as TrackingApiError).status).toBe(400);
    expect((err as TrackingApiError).body).toContain('VALIDATION_FAILED');
  });

  it('returns the parsed body on a happy-path 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(sampleTracking), { status: 200 }));
    const result = await trackOrder('1042', 'shopper@example.com', fetchImpl);
    expect(result.shipment).toEqual({ carrier: 'Servientrega', trackingNumber: 'SV-123' });
    expect(result.events).toHaveLength(2);
  });
});
