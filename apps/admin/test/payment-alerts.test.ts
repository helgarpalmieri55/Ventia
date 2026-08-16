import { describe, expect, it } from 'vitest';
import {
  alertGuidance,
  alertsBannerSummary,
  alertsCountLabel,
  providerLabel,
  REVIEW_ACTION_LABEL,
  REVIEW_ACTION_OPTIONS,
  type PaymentAlertOrder,
} from '../lib/payment-alerts-api';

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
      'Recibiste 1 pago que no se pudo aplicar a ningún pedido. Al cliente ya le cobraron.',
    );
  });

  it('uses real Spanish plural for several', () => {
    expect(alertsBannerSummary(3)).toBe(
      'Recibiste 3 pagos que no se pudieron aplicar a ningún pedido. A esos clientes ya les cobraron.',
    );
  });

  it('stays in tuteo, like the rest of the admin copy', () => {
    // The banner used to say "su pedido" (usted) while the page next to it
    // said "Recibiste"/"tu pasarela" (tuteo). lib/errors.ts settles the
    // question for the whole app: "Alcanzaste el límite de tu plan", "Debes
    // iniciar sesión". One register, everywhere.
    for (const total of [1, 4]) {
      expect(alertsBannerSummary(total)).toContain('Recibiste');
      expect(alertsBannerSummary(total)).not.toContain('su pedido');
      expect(alertsBannerSummary(total)).not.toContain('sus pedidos');
    }
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

function order(overrides: Partial<PaymentAlertOrder> = {}): PaymentAlertOrder {
  return {
    id: 'order-1',
    number: 1234,
    status: 'CANCELLED',
    paymentStatus: 'PENDING',
    createdAt: '2026-08-10T00:00:00.000Z',
    email: 'comprador@example.com',
    ...overrides,
  };
}

describe('alertGuidance', () => {
  // `paid_order_not_settleable` is one result code covering situations with
  // OPPOSITE remedies. The old page asserted the cancelled-order story for
  // every row, which told a merchant to refund against an order they had
  // already delivered.

  it('tells the cancelled/expired story when the order was never paid', () => {
    const g = alertGuidance({ order: order({ status: 'CANCELLED', paymentStatus: 'PENDING' }) });

    expect(g.cause).toBe('expired');
    expect(g.whatHappened).toContain('ya no se podía completar');
    expect(g.whatHappened).toContain('se quedó sin pedido');
    // The 15-minute reservation is the actual mechanism, and naming it is
    // what lets a merchant recognize the pattern.
    expect(g.whatHappened).toContain('15 minutos');
  });

  it('tells the DOUBLE-CHARGE story when the order was already settled', () => {
    const g = alertGuidance({ order: order({ status: 'DELIVERED', paymentStatus: 'PAID' }) });

    expect(g.cause).toBe('double_charge');
    // The customer HAS an order. Saying otherwise is the money-losing part.
    expect(g.whatHappened).toContain('ya estaba pagado');
    expect(g.whatToDo).toContain('sí tiene su pedido');
    expect(g.whatToDo).toContain('únicamente este cobro duplicado');
  });

  it('gives OPPOSITE guidance for the two causes — that is the whole point', () => {
    const settled = alertGuidance({ order: order({ status: 'DELIVERED', paymentStatus: 'PAID' }) });
    const expired = alertGuidance({ order: order({ status: 'CANCELLED', paymentStatus: 'PENDING' }) });

    expect(settled.cause).not.toBe(expired.cause);
    expect(settled.whatToDo).not.toBe(expired.whatToDo);
    // Never tell a merchant a delivered customer has no order.
    expect(settled.whatHappened).not.toContain('sin pedido');
    expect(settled.whatToDo).not.toContain('pedido nuevo');
    // And never tell an expired case that the customer already has theirs.
    expect(expired.whatToDo).not.toContain('sí tiene su pedido');
  });

  it('treats a PAID order as a double charge at ANY fulfilment stage', () => {
    // markPaid refuses any order not PENDING+(PENDING|FAILED), so a second
    // PAID event can land on a CONFIRMED, SHIPPED or DELIVERED order alike —
    // and even on one that was PAID and later CANCELLED.
    for (const status of ['CONFIRMED', 'PREPARING', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const) {
      expect(alertGuidance({ order: order({ status, paymentStatus: 'PAID' }) }).cause).toBe('double_charge');
    }
  });

  it('claims to know nothing when the order could not be identified', () => {
    const g = alertGuidance({ order: null });

    expect(g.cause).toBe('unidentified');
    expect(g.whatHappened).toContain('No pudimos identificar');
    expect(g.whatToDo).toContain('panel de tu pasarela');
    // Must not assert either story.
    expect(g.whatHappened).not.toContain('ya estaba pagado');
    expect(g.whatHappened).not.toContain('venció la reserva');
  });

  it('NEVER instructs an action the admin panel cannot perform', () => {
    // orders.controller.ts has no @Post and the admin has no order-creation
    // UI, so "toma el pedido de nuevo [aquí]" was an impossible instruction.
    // A customer who takes it again places a NEW order in the storefront.
    const all = [
      alertGuidance({ order: order({ paymentStatus: 'PENDING' }) }),
      alertGuidance({ order: order({ paymentStatus: 'PAID' }) }),
      alertGuidance({ order: null }),
    ];

    for (const g of all) {
      const text = `${g.whatHappened} ${g.whatToDo}`;
      expect(text).not.toContain('toma el pedido de nuevo');
      expect(text).not.toContain('vuelve a crear el pedido');
    }

    // The expired case says the restriction out loud rather than staying
    // silent about it.
    const expired = alertGuidance({ order: order({ paymentStatus: 'PENDING' }) });
    expect(expired.whatToDo).toContain('no se puede revivir desde el panel');
    expect(expired.whatToDo).toContain('pedido nuevo en tu tienda');
  });

  it('keeps refunds framed as out-of-band, in the gateway dashboard', () => {
    for (const alert of [{ order: order({ paymentStatus: 'PENDING' }) }, { order: order({ paymentStatus: 'PAID' }) }]) {
      expect(alertGuidance(alert).whatToDo).toContain('panel de tu pasarela');
    }
  });
});

describe('review action copy', () => {
  it('offers the four real outcomes to pick from, and never the undo', () => {
    expect(REVIEW_ACTION_OPTIONS.map((o) => o.value)).toEqual([
      'refunded',
      'order_taken_again',
      'no_action_needed',
      'other',
    ]);
    // `reopened` is not a resolution — it is the correction, and it gets its
    // own button in "Revisados" rather than a slot in this menu.
    expect(REVIEW_ACTION_OPTIONS.map((o) => o.value)).not.toContain('reopened');
  });

  it('labels every action, including the undo, in merchant Spanish', () => {
    for (const [action, label] of Object.entries(REVIEW_ACTION_LABEL)) {
      expect(label.length).toBeGreaterThan(0);
      // No raw enum names leaking into the UI.
      expect(label).not.toContain('_');
      expect(label).not.toBe(action);
    }
    expect(REVIEW_ACTION_LABEL.reopened).toBe('Lo reabrió');
  });
});
