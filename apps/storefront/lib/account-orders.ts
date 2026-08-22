import { AccountApiError } from './account-api';

/**
 * Display helpers for the order history on `/cuenta` — the pure half of that
 * page, here rather than inline so it can be unit-tested (this app has no DOM
 * test runner; see `mutation-queue.ts`'s note).
 *
 * The status labels duplicate the ones in `app/rastrear/page.tsx` on purpose,
 * rather than that page's private const being exported and imported here.
 * They are two audiences reading two different screens — the tracking page
 * speaks to someone holding an order number, this one to someone reading
 * their own history — and this codebase's established convention is a local
 * copy per module over a shared one (see `format.ts`'s header, and the
 * duplicated proxy routes). What is NOT duplicated is the enum they key off:
 * both come from `packages/db/prisma/schema.prisma`.
 */

/** `OrderStatus` in the Prisma schema. */
const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pendiente',
  CONFIRMED: 'Confirmado',
  PREPARING: 'Preparando',
  SHIPPED: 'Enviado',
  DELIVERED: 'Entregado',
  CANCELLED: 'Cancelado',
};

/** `PaymentStatus` in the Prisma schema. `COD` is not a payment state so much
 * as a payment ARRANGEMENT — the shopper pays the courier — so it reads as
 * the arrangement rather than as a pending payment they might think they need
 * to go and complete. */
const PAYMENT_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pago pendiente',
  PAID: 'Pagado',
  FAILED: 'Pago fallido',
  EXPIRED: 'Pago vencido',
  COD: 'Pago contra entrega',
};

/**
 * Both label lookups fall back to the RAW value instead of throwing or
 * printing a placeholder.
 *
 * The API is deployed separately from this app and is free to add an enum
 * member first. A storefront that crashed — or silently showed "Desconocido"
 * — on a status it had not heard of would take out a shopper's whole order
 * history over a value it merely could not translate. An untranslated
 * `REFUNDED` is a worse-looking row; a blank page is a support call.
 */
export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status] ?? status;
}

export function paymentStatusLabel(paymentStatus: string): string {
  return PAYMENT_STATUS_LABELS[paymentStatus] ?? paymentStatus;
}

/** `Badge` variants from `@ventia/ui`. Only a genuinely failed or expired
 * payment gets the destructive (red) treatment: a pending one is normal for
 * a fresh order, and colouring it as a fault invites a shopper to pay twice. */
export function paymentStatusTone(paymentStatus: string): 'default' | 'secondary' | 'destructive' {
  if (paymentStatus === 'PAID') return 'default';
  if (paymentStatus === 'FAILED' || paymentStatus === 'EXPIRED') return 'destructive';
  return 'secondary';
}

/** The `VNT-####` customer-facing prefix, same convention as the confirmation
 * page, the tracking page and the order emails — a local copy per this
 * codebase's no-shared-helper-for-four-characters convention. It matters that
 * it matches: this is the number the shopper quotes on WhatsApp. */
export function formatOrderNumber(orderNumber: number): string {
  return `VNT-${orderNumber}`;
}

const DATE_FORMATTER = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  // Pinned to Bogotá rather than left to the viewer's clock. An order placed
  // at 21:30 on the 3rd is stored as 02:30Z on the 4th, and a browser in
  // another zone would date it a day later than the confirmation email the
  // shopper is holding — for a store whose customers and whose merchant are
  // both in Colombia, the merchant's own day is the only right answer.
  timeZone: 'America/Bogota',
});

/** Returns the RAW value for an unparseable date rather than "Invalid Date"
 * or an empty cell: if the API ever sends something unexpected, showing it is
 * both honest to the shopper and the fastest way for whoever is debugging to
 * see what arrived. */
export function formatOrderDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return DATE_FORMATTER.format(date);
}

/**
 * Whether a failure from `fetchMyOrders` is the "confirm your address first"
 * case (403) rather than a fault.
 *
 * This is a normal state with a clear next step, not an error: the API gates
 * order history on a VERIFIED address because registration links an account
 * to a customer by matching email, and anyone can register with someone
 * else's. The page turns this into "confirma tu correo", never into a generic
 * failure — a shopper told only "algo salió mal" would retry forever.
 */
export function isEmailNotVerified(err: unknown): boolean {
  return err instanceof AccountApiError && err.code === 'EMAIL_NOT_VERIFIED';
}
