import type { Mailer } from './mailer';

/**
 * The one email the subscription sweep sends: the warning a merchant gets
 * before Ventia takes their store offline for non-payment (docs/SPEC.md §6 M9
 * — "auto-suspend N days past due … with warning email at N-3").
 *
 * Unlike every other template in this directory, this one is from VENTIA to
 * the MERCHANT — not from a store to its shopper. The voice is accordingly
 * direct and unapologetic about the consequence: an email that buries "your
 * store will go offline on the 7th" under pleasantries is an email that fails
 * at the only thing it exists to do. It is also the merchant's last chance to
 * act before the sweep suspends them, so it names the exact date, the exact
 * amount, and what to do about it.
 *
 * Sent by `subscription-sweep.worker.ts`, which claims a `NotificationLog` row
 * (unique `idempotencyKey`) BEFORE calling this — so a daily sweep across a
 * three-day warning window sends exactly one of these per billing cycle, not
 * one per run. See that file.
 */

// A fourth small copy of the es-CO COP formatter, per the per-module-copy
// convention order-emails.ts documents (which itself is the third).
const copFormatter = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});
/** U+00A0 NO-BREAK SPACE — what Intl inserts between the currency symbol and
 * the digits; normalized to a plain space, same convention as order-emails.ts.
 * Written as an escape rather than as a literal character: the two are
 * indistinguishable by eye in a diff, and a copy that silently became an
 * ordinary space would leave a NBSP in every email body and break every
 * assertion that greps one. */
const NBSP = '\u00A0';

function formatCOP(cents: number): string {
  return copFormatter.format(Math.round(cents / 100)).replaceAll(NBSP, ' ');
}

/**
 * Dates are rendered in `America/Bogota`, not UTC. A merchant reading "tu
 * tienda se suspende el 7 de septiembre" must see the day it happens in THEIR
 * calendar; a `paidUntil` stored as 2026-09-01T04:59Z is the 31st of August
 * where they are, and printing the UTC day would tell them the wrong date by
 * one for every subscription recorded as a plain date.
 */
const dateFormatter = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'long',
  timeZone: 'America/Bogota',
});

function formatDate(date: Date): string {
  return dateFormatter.format(date);
}

export interface SubscriptionWarningEmailContext {
  /** Where the notice goes — the tenant owner's account email (see the
   * worker's `resolveBillingRecipient`). */
  to: string;
  tenantName: string;
  /** Monthly price on record, in COP cents. */
  priceCents: number;
  /** The end of the paid period the merchant has run past. */
  paidUntil: Date;
  /** When the sweep will suspend the store if nothing is paid. */
  suspendsOn: Date;
}

export async function sendSubscriptionWarningEmail(
  mailer: Mailer,
  ctx: SubscriptionWarningEmailContext,
): Promise<void> {
  await mailer.send({
    to: ctx.to,
    subject: `Tu suscripción de ${ctx.tenantName} está vencida`,
    text: [
      `Hola,`,
      '',
      `Tu suscripción de Ventia para ${ctx.tenantName} venció el ${formatDate(ctx.paidUntil)} y todavía no registramos el pago.`,
      '',
      `Valor pendiente: ${formatCOP(ctx.priceCents)}`,
      '',
      `Si no recibimos el pago, tu tienda se suspenderá automáticamente el ${formatDate(ctx.suspendsOn)}. Mientras esté suspendida, tus clientes no podrán ver el catálogo ni comprar.`,
      '',
      `Si ya pagaste, responde a este correo con el comprobante y lo registramos de inmediato. Si necesitas más plazo, escríbenos antes de esa fecha y lo conversamos.`,
      '',
      `Equipo Ventia`,
    ].join('\n'),
  });
}
