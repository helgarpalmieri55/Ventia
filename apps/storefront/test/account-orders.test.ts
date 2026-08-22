import { describe, expect, it } from 'vitest';
import { AccountApiError } from '../lib/account-api';
import {
  formatOrderDate,
  formatOrderNumber,
  isEmailNotVerified,
  orderStatusLabel,
  paymentStatusLabel,
  paymentStatusTone,
} from '../lib/account-orders';

describe('orderStatusLabel', () => {
  it.each([
    ['PENDING', 'Pendiente'],
    ['CONFIRMED', 'Confirmado'],
    ['PREPARING', 'Preparando'],
    ['SHIPPED', 'Enviado'],
    ['DELIVERED', 'Entregado'],
    ['CANCELLED', 'Cancelado'],
  ])('labels %s', (status, label) => {
    expect(orderStatusLabel(status)).toBe(label);
  });

  it('falls back to the raw value for a status this build has not heard of', () => {
    // The API deploys separately and may add an enum member first. An
    // untranslated row is a worse-looking row; a crash is a shopper with no
    // order history at all.
    expect(orderStatusLabel('REFUNDED')).toBe('REFUNDED');
  });
});

describe('paymentStatusLabel', () => {
  it.each([
    ['PENDING', 'Pago pendiente'],
    ['PAID', 'Pagado'],
    ['FAILED', 'Pago fallido'],
    ['EXPIRED', 'Pago vencido'],
    ['COD', 'Pago contra entrega'],
  ])('labels %s', (status, label) => {
    expect(paymentStatusLabel(status)).toBe(label);
  });

  it('falls back to the raw value for an unknown payment status', () => {
    expect(paymentStatusLabel('REFUNDED')).toBe('REFUNDED');
  });
});

describe('paymentStatusTone', () => {
  it('marks only a genuinely failed or expired payment as destructive', () => {
    expect(paymentStatusTone('FAILED')).toBe('destructive');
    expect(paymentStatusTone('EXPIRED')).toBe('destructive');
  });

  it('does not colour a pending payment as a fault', () => {
    // Pending is normal for a fresh order; a red badge there invites a
    // shopper to pay a second time.
    expect(paymentStatusTone('PENDING')).toBe('secondary');
    expect(paymentStatusTone('COD')).toBe('secondary');
  });

  it('highlights a paid order', () => {
    expect(paymentStatusTone('PAID')).toBe('default');
  });

  it('treats an unknown status as neutral rather than as a failure', () => {
    expect(paymentStatusTone('REFUNDED')).toBe('secondary');
  });
});

describe('formatOrderNumber', () => {
  it('uses the same VNT- prefix the emails and the confirmation page use', () => {
    // This is the number the shopper quotes on WhatsApp; it has to match what
    // they were sent.
    expect(formatOrderNumber(1042)).toBe('VNT-1042');
  });
});

describe('formatOrderDate', () => {
  it('dates an order in Bogotá time, not the viewer’s', () => {
    // 02:30Z on the 4th is 21:30 on the 3rd in Colombia. A browser in another
    // zone would date this order a day later than the confirmation email the
    // shopper is holding.
    expect(formatOrderDate('2026-03-04T02:30:00.000Z')).toBe('3 de marzo de 2026');
  });

  it('does not roll the date backwards for a morning order', () => {
    expect(formatOrderDate('2026-03-04T14:00:00.000Z')).toBe('4 de marzo de 2026');
  });

  it('returns the raw value for an unparseable date instead of "Invalid Date"', () => {
    expect(formatOrderDate('no es una fecha')).toBe('no es una fecha');
  });
});

describe('isEmailNotVerified', () => {
  it('recognises the 403 as the "confirm your address" state', () => {
    expect(isEmailNotVerified(new AccountApiError(403, 'EMAIL_NOT_VERIFIED'))).toBe(true);
  });

  it('does not swallow other failures as that state', () => {
    // A 500 rendered as "confirm your address" would send a verified shopper
    // to check an inbox for nothing.
    expect(isEmailNotVerified(new AccountApiError(500, 'UNKNOWN'))).toBe(false);
    expect(isEmailNotVerified(new AccountApiError(403, 'SOMETHING_ELSE'))).toBe(false);
    expect(isEmailNotVerified(new Error('EMAIL_NOT_VERIFIED'))).toBe(false);
  });
});
