import { describe, expect, it } from 'vitest';
import { alertsBannerSummary, alertsCountLabel, providerLabel } from '../lib/payment-alerts-api';

describe('providerLabel', () => {
  it('renders merchant-facing gateway names, not raw ids', () => {
    expect(providerLabel('wompi')).toBe('Wompi');
    expect(providerLabel('mercadopago')).toBe('Mercado Pago');
    expect(providerLabel('epayco')).toBe('ePayco');
  });

  it('falls back to the raw id for an unknown gateway rather than to a generic word', () => {
    // The raw id is what a merchant would quote in a support ticket; a
    // generic "Pasarela" would destroy that.
    expect(providerLabel('some-future-gateway')).toBe('some-future-gateway');
  });
});

describe('alertsBannerSummary', () => {
  it('uses real Spanish singular for one alert', () => {
    expect(alertsBannerSummary(1)).toBe(
      'Recibiste 1 pago que no se pudo aplicar a su pedido. Al cliente ya le cobraron.',
    );
  });

  it('uses real Spanish plural for several', () => {
    expect(alertsBannerSummary(3)).toBe(
      'Recibiste 3 pagos que no se pudieron aplicar a sus pedidos. A esos clientes ya les cobraron.',
    );
  });

  it('never emits a machine-looking "(s)" or a raw enum name', () => {
    for (const total of [1, 2, 7, 100]) {
      const text = alertsBannerSummary(total);
      expect(text).not.toContain('(s)');
      expect(text).not.toContain('paid_order_not_settleable');
      expect(text).not.toContain('webhook');
      expect(text).not.toContain('WebhookEvent');
    }
  });

  it('always says the money already left the customer — that is the whole point', () => {
    expect(alertsBannerSummary(1).toLowerCase()).toContain('cobraron');
    expect(alertsBannerSummary(5).toLowerCase()).toContain('cobraron');
  });
});

describe('alertsCountLabel', () => {
  it('agrees in number', () => {
    expect(alertsCountLabel(1)).toBe('1 pago por revisar');
    expect(alertsCountLabel(0)).toBe('0 pagos por revisar');
    expect(alertsCountLabel(4)).toBe('4 pagos por revisar');
  });
});
