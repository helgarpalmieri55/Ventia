import type { Mailer } from './mailer';

// Same es-CO COP-formatting convention as `apps/admin/lib/format.ts` and
// `apps/storefront/lib/format.ts`'s near-identical `formatCOP` copies (per
// this codebase's established per-module-copy convention for this small
// formatter) — a third small copy here for plain-text email bodies, not a
// new pattern.
const copFormatter = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});
// U+00A0 NO-BREAK SPACE: what Intl actually inserts between the currency
// symbol and the digits, normalized below to a plain space (U+0020) --
// same convention/rationale as apps/admin/lib/format.ts's formatCOP.
const NBSP = ' ';

function formatCOP(cents: number): string {
  const pesos = Math.round(cents / 100);
  return copFormatter.format(pesos).replaceAll(NBSP, ' ');
}

/** Order numbers are always rendered with this prefix in customer/merchant-
 * facing text (spec's "never expose raw UUIDs... e.g. VNT-1042") — the DB
 * column itself stays a plain sequential `Int`. */
function vnt(orderNumber: number): string {
  return `VNT-${orderNumber}`;
}

export interface OrderEmailContext {
  orderNumber: number;
  email: string;
  phone: string;
  totalCents: number;
  items: Array<{ nameSnapshot: string; qty: number; priceCentsSnapshot: number }>;
  shippingAddress: { departamentoName: string; municipioName: string };
  merchantContactEmail: string | null;
  tenantName: string;
}

function itemLines(items: OrderEmailContext['items']): string {
  return items
    .map((item) => `- ${item.nameSnapshot} x${item.qty} — ${formatCOP(item.priceCentsSnapshot * item.qty)}`)
    .join('\n');
}

/** Shared shape for the 3 order-status-transition emails below (confirmed/
 * shipped/delivered) — trimmed to what each template actually needs, unlike
 * order-creation's wider {@link OrderEmailContext}. */
export interface OrderStatusEmailContext {
  orderNumber: number;
  email: string;
  tenantName: string;
}

export interface OrderShippedEmailContext extends OrderStatusEmailContext {
  carrier: string;
  trackingNumber: string;
}

/**
 * Sent when a staff member confirms a PENDING order (transition -> CONFIRMED)
 * — the shopper's earlier "we'll call you to confirm" email
 * (sendOrderEmails's 2nd email) is now followed up with "yes, confirmed,
 * we're preparing it." Fire-and-forget from `OrdersService.transition`, same
 * post-commit `.catch(console.error)` pattern as sendOrderEmails's call site
 * — no merchant-facing alert here, since the merchant is the one who just
 * took this action in the admin.
 */
export async function sendOrderConfirmedEmail(mailer: Mailer, ctx: OrderStatusEmailContext): Promise<void> {
  const orderLabel = vnt(ctx.orderNumber);
  await mailer.send({
    to: ctx.email,
    subject: `Tu pedido #${orderLabel} fue confirmado — ${ctx.tenantName}`,
    text: [
      `¡Buenas noticias! Tu pedido #${orderLabel} en ${ctx.tenantName} fue confirmado y lo estamos preparando.`,
      '',
      `Te avisaremos por correo cuando salga hacia tu dirección.`,
    ].join('\n'),
  });
}

/**
 * Sent when a staff member marks an order SHIPPED. Carries the
 * carrier/tracking number entered in the admin so the shopper can track the
 * package themselves.
 */
export async function sendOrderShippedEmail(mailer: Mailer, ctx: OrderShippedEmailContext): Promise<void> {
  const orderLabel = vnt(ctx.orderNumber);
  await mailer.send({
    to: ctx.email,
    subject: `Tu pedido #${orderLabel} fue enviado — ${ctx.tenantName}`,
    text: [
      `Tu pedido #${orderLabel} en ${ctx.tenantName} ya está en camino.`,
      '',
      `Transportadora: ${ctx.carrier}`,
      `Número de guía: ${ctx.trackingNumber}`,
    ].join('\n'),
  });
}

/**
 * Sent when a staff member marks an order DELIVERED — the last email in the
 * order lifecycle, a short thank-you note.
 */
export async function sendOrderDeliveredEmail(mailer: Mailer, ctx: OrderStatusEmailContext): Promise<void> {
  const orderLabel = vnt(ctx.orderNumber);
  await mailer.send({
    to: ctx.email,
    subject: `Tu pedido #${orderLabel} fue entregado — ${ctx.tenantName}`,
    text: [
      `Tu pedido #${orderLabel} en ${ctx.tenantName} fue entregado. ¡Gracias por tu compra!`,
    ].join('\n'),
  });
}

/**
 * Sends the 3 order-creation emails (2 shopper-facing, 1 merchant-facing)
 * through the given `mailer` — never constructs its own Mailer, so callers
 * (and tests) can pass a recording double. Called fire-and-forget from
 * `CheckoutService.checkout` after the order transaction commits; a failure
 * here must never surface to the checkout HTTP response, so this function
 * itself does NOT swallow errors — that's the call site's job (see
 * checkout.service.ts's `.catch(...)`), not this function's.
 */
export async function sendOrderEmails(mailer: Mailer, ctx: OrderEmailContext): Promise<void> {
  const orderLabel = vnt(ctx.orderNumber);
  const total = formatCOP(ctx.totalCents);
  const { departamentoName, municipioName } = ctx.shippingAddress;

  // 1. Confirmation to the shopper: what was ordered, and the total.
  await mailer.send({
    to: ctx.email,
    subject: `Confirmación de tu pedido #${orderLabel} — ${ctx.tenantName}`,
    text: [
      `¡Gracias por tu compra en ${ctx.tenantName}!`,
      '',
      `Pedido #${orderLabel}`,
      '',
      itemLines(ctx.items),
      '',
      `Total: ${total}`,
      '',
      `Enviaremos tu pedido a: ${municipioName}, ${departamentoName}.`,
    ].join('\n'),
  });

  // 2. COD confirmation request (spec M10): the merchant will call/WhatsApp
  // to confirm before shipping — sent separately from the order summary
  // above so each email stays focused on one purpose.
  await mailer.send({
    to: ctx.email,
    subject: `Tu pedido contra entrega #${orderLabel}`,
    text: [
      `Tu pedido #${orderLabel} en ${ctx.tenantName} se pagará contra entrega.`,
      '',
      `Antes de enviarlo, nos comunicaremos contigo por teléfono o WhatsApp al ${ctx.phone} para confirmar los detalles de tu pedido.`,
      '',
      `Total a pagar contra entrega: ${total}`,
    ].join('\n'),
  });

  // 3. New-order alert to the merchant — skipped entirely if they never set
  // a contact email in storeInfo (no invented fallback address).
  if (ctx.merchantContactEmail !== null) {
    await mailer.send({
      to: ctx.merchantContactEmail,
      subject: `Nuevo pedido #${orderLabel}`,
      text: [
        `Recibiste un nuevo pedido #${orderLabel} por ${total}.`,
        '',
        `Contacto del comprador:`,
        `Correo: ${ctx.email}`,
        `Teléfono: ${ctx.phone}`,
        '',
        `Dirección de envío: ${municipioName}, ${departamentoName}.`,
      ].join('\n'),
    });
  }
}
