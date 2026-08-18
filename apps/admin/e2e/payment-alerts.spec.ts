import { test, expect } from '@playwright/test';
import { platformDb } from '@ventia/db';

/**
 * P3 wave-3 e2e: the "Pagos por revisar" operator surface, end to end in a
 * real browser against the real dev stack.
 *
 * What this exists to prove — each item is something a unit test cannot,
 * because the failure it guards against is about what a MERCHANT SEES on the
 * assembled page rather than about a function's return value:
 *
 *  1. The two causes of `paid_order_not_settleable` render DIFFERENT, and
 *     opposite, guidance on the same table. The bug this replaces put one
 *     blanket paragraph above the table asserting the customer "no tiene un
 *     pedido" — directly above a row reading "Entregado / PAID". Proving the
 *     fix means reading both rows off one rendered page.
 *  2. No row anywhere instructs an action the panel cannot perform ("toma el
 *     pedido de nuevo").
 *  3. A `providerRefSource: 'hint'` link never surfaces an order or a
 *     "Monto cobrado" — the money-shaped output stays empty for an untrusted
 *     link even though a matching (DELIVERED/PAID, $999.000) order exists.
 *  4. The review flow: reviewing an alert drops it out of the shell BANNER
 *     and the pending table, and it reappears under "Revisados" with who
 *     reviewed it — then "Reabrir" puts it back in the alarm.
 *
 * Fixture strategy matches p2-dod.spec.ts: one real UI signup so the browser
 * holds a genuine better-auth session, then Tenant/Membership/Order/
 * WebhookEvent rows seeded directly through `platformDb`. The states this
 * feature is about (an order CANCELLED by the expiry worker, a
 * `paid_order_not_settleable` webhook row) are reached by background workers
 * and signed gateway deliveries, not by anything the admin UI can drive.
 *
 * Run via `bash scripts/e2e.sh` (NOT directly) — that script boots API +
 * admin + storefront against the running dev stack and exports DATABASE_URL
 * before Playwright loads `platformDb` above.
 */

const ts = Date.now();
const OWNER_EMAIL = `alerts-e2e-${ts}@demo.co`;
const OWNER_PASSWORD = 'Dod-Secreta-2026!';
const STORE_SLUG = `alerts-e2e-${ts}`;

/** Order numbers are per-tenant, so fixed values are safe inside a fresh one. */
const CANCELLED_ORDER = 7001;
const SETTLED_ORDER = 7002;
const PLANTED_ORDER = 7003;

function wompiPayload(reference: string) {
  return {
    event: 'transaction.updated',
    data: {
      transaction: {
        id: `wompi-tx-${reference}-${ts}`,
        reference,
        status: 'APPROVED',
        amount_in_cents: 150_000,
        currency: 'COP',
        customer_email: 'comprador@example.com',
      },
      signature: { checksum: 'deadbeef', properties: ['transaction.id'] },
    },
  };
}

test('pagos por revisar: per-cause guidance, untrusted refs, and the review flow', async ({ page }) => {
  // --- one real signup, so the browser holds a genuine session cookie ---
  await page.goto('/registro');
  await page.getByLabel('Nombre').fill('Dueña Alertas');
  await page.getByLabel('Correo').fill(OWNER_EMAIL);
  await page.getByLabel('Contraseña').fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: /crear cuenta/i }).click();
  await page.waitForURL(/\/onboarding/, { timeout: 60_000 });

  const user = await platformDb.user.findUniqueOrThrow({ where: { email: OWNER_EMAIL } });
  const tenant = await platformDb.tenant.create({
    data: { slug: STORE_SLUG, name: `Tienda Alertas ${ts}`, status: 'live' },
  });
  await platformDb.membership.create({ data: { userId: user.id, tenantId: tenant.id, role: 'owner' } });

  const seedOrder = (number: number, over: Record<string, unknown>) =>
    platformDb.order.create({
      data: {
        tenantId: tenant.id,
        number,
        email: 'comprador@example.com',
        phone: '3001234567',
        shippingAddress: {},
        taxCents: 0,
        paymentProvider: 'wompi',
        ...over,
      } as never,
    });

  // `orderId` is what the alerts list resolves through — the link the webhook
  // handler records when it processes a delivery (WebhookEvent.orderId). It is
  // passed explicitly here because these rows are seeded directly rather than
  // by the handler; `null` seeds the unresolvable case on purpose.
  const seedEvent = (provider: string, eventId: string, payload: unknown, orderId: string | null) =>
    platformDb.webhookEvent.create({
      data: {
        provider,
        eventId,
        tenantId: tenant.id,
        payload: payload as never,
        orderId,
        processedAt: new Date(),
        result: 'paid_order_not_settleable',
      },
    });

  // CAUSE 1 — the expiry case: cancelled before the payment landed.
  const cancelledOrder = await seedOrder(CANCELLED_ORDER, {
    status: 'CANCELLED',
    paymentStatus: 'PENDING',
    subtotalCents: 150_000,
    totalCents: 150_000,
  });
  await seedEvent('wompi', `e2e-cancelado-${ts}`, wompiPayload(String(CANCELLED_ORDER)), cancelledOrder.id);

  // CAUSE 2 — the DOUBLE CHARGE: a second PAID event on a delivered order.
  const settledOrder = await seedOrder(SETTLED_ORDER, {
    status: 'DELIVERED',
    paymentStatus: 'PAID',
    subtotalCents: 240_000,
    totalCents: 240_000,
  });
  await seedEvent('wompi', `e2e-doble-cobro-${ts}`, wompiPayload(String(SETTLED_ORDER)), settledOrder.id);

  // UNTRUSTED — a hint-sourced Mercado Pago ref pointing at a big
  // DELIVERED/PAID order, on an event the handler linked to NO order. Must
  // resolve to nothing: the alerts list reads `WebhookEvent.orderId` and
  // nothing else, so neither the payload nor `Order.providerRef` can steer
  // which order (and therefore which remedy) the merchant is shown.
  const plantedRef = `mp-plantado-${ts}`;
  await seedOrder(PLANTED_ORDER, {
    status: 'DELIVERED',
    paymentStatus: 'PAID',
    subtotalCents: 999_000,
    totalCents: 999_000,
    paymentProvider: 'mercadopago',
    providerRef: plantedRef,
    providerRefSource: 'hint',
  });
  await seedEvent('mercadopago', `e2e-hint-${ts}`, { type: 'payment', data: { id: plantedRef } }, null);

  // --- the shell banner: present on a page that is not the alerts page ---
  await page.goto('/productos');
  const banner = page.getByText(/Hay pagos que no se aplicaron a ningún pedido/);
  await expect(banner).toBeVisible();
  await expect(page.getByText(/Recibiste 3 pagos que no se pudieron aplicar a ningún pedido/)).toBeVisible();

  await page.getByRole('link', { name: /revisar ahora/i }).click();
  await page.waitForURL(/\/pagos-por-revisar/, { timeout: 60_000 });

  // --- 1 + 2: the two causes render OPPOSITE guidance on one page ---
  const cancelledRow = page.locator('tr', { hasText: `VNT-${CANCELLED_ORDER}` });
  const settledRow = page.locator('tr', { hasText: `VNT-${SETTLED_ORDER}` });
  await expect(cancelledRow).toBeVisible();
  await expect(settledRow).toBeVisible();

  // The expired case: the customer was left WITHOUT an order, the panel
  // cannot revive it, and a re-take means a brand-new order.
  await expect(cancelledRow).toContainText('se quedó sin pedido');
  await expect(cancelledRow).toContainText('no se puede revivir desde el panel');
  await expect(cancelledRow).toContainText('pedido nuevo en tu tienda');

  // The double-charge case, on the very same table: the customer DOES have
  // their order, and only the duplicate is refunded.
  await expect(settledRow).toContainText('Entregado');
  await expect(settledRow).toContainText('ya estaba pagado');
  await expect(settledRow).toContainText('sí tiene su pedido');
  await expect(settledRow).toContainText('únicamente este cobro duplicado');
  // The exact bug this replaces: a delivered customer told they have none.
  await expect(settledRow).not.toContainText('se quedó sin pedido');

  // --- 2: nothing anywhere instructs the impossible panel action ---
  const pageText = (await page.locator('body').innerText()).toLowerCase();
  expect(pageText).not.toContain('toma el pedido de nuevo');
  // ...and the limitation is stated rather than left implicit.
  expect(pageText).toContain('los pedidos no se crean ni se reviven desde el panel');

  // --- 3: the hint-sourced ref resolves to NOTHING, with no amount ---
  const plantedRow = page.locator('tr', { hasText: `e2e-hint-${ts}` });
  await expect(plantedRow).toBeVisible();
  await expect(plantedRow).toContainText('No identificado');
  await expect(plantedRow).toContainText('Consúltalo en tu pasarela');
  // The planted order's total must never appear as "Monto cobrado".
  await expect(plantedRow).not.toContainText('999.000');
  await expect(plantedRow).not.toContainText(`VNT-${PLANTED_ORDER}`);

  // --- 4: review the double-charge row; it leaves the alarm ---
  await settledRow.getByLabel('Qué hiciste con este pago').selectOption('refunded');
  await settledRow.getByLabel('Nota (opcional)').fill('Devuelto en Wompi, recibo 8891');
  await settledRow.getByRole('button', { name: /marcar como revisado/i }).click();

  // Gone from the pending table...
  await expect(page.locator('tr', { hasText: `VNT-${SETTLED_ORDER}` }).first()).toContainText('Devolvió el dinero', {
    timeout: 30_000,
  });
  const revisados = page.locator('section, div').filter({ hasText: 'Revisados' });
  await expect(revisados.first()).toBeVisible();
  // ...and present under "Revisados" WITH the actor and the note.
  const reviewedRow = page.locator('tr', { hasText: `VNT-${SETTLED_ORDER}` }).first();
  await expect(reviewedRow).toContainText(OWNER_EMAIL);
  await expect(reviewedRow).toContainText('Devuelto en Wompi, recibo 8891');

  // The banner count dropped by one on the rest of the shell.
  await page.goto('/productos');
  await expect(page.getByText(/Recibiste 2 pagos que no se pudieron aplicar a ningún pedido/)).toBeVisible();

  // --- 4b: "Reabrir" is an UNDO that puts it back in the alarm ---
  await page.goto('/pagos-por-revisar');
  await page.locator('tr', { hasText: `VNT-${SETTLED_ORDER}` }).first()
    .getByRole('button', { name: /reabrir/i })
    .click();

  await page.goto('/productos');
  await expect(page.getByText(/Recibiste 3 pagos que no se pudieron aplicar a ningún pedido/)).toBeVisible();

  // The undo was an APPEND: both the review and its reversal are on record,
  // and nothing was deleted.
  const history = await platformDb.webhookEventReview.findMany({
    where: { tenantId: tenant.id },
    orderBy: { createdAt: 'asc' },
  });
  expect(history.map((r) => r.action)).toEqual(['refunded', 'reopened']);
  expect(history[0].reviewedByEmail).toBe(OWNER_EMAIL);
  expect(history[0].note).toBe('Devuelto en Wompi, recibo 8891');
});
