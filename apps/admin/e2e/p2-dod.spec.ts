import { test, expect, type Locator, type Page } from '@playwright/test';
import { platformDb } from '@ventia/db';

/**
 * P2 Definition-of-Done e2e (Task 6, P2c's wrap-up): the FULL P2 vertical
 * slice in one flow — storefront browsing (P2a) → add to cart → cart page →
 * checkout (COD, P2b) → admin order fulfillment confirm→preparing→shipped→
 * delivered (P2c) → public order tracking by number+contact showing the
 * final status, carrier/tracking number, and timeline (P2c) — plus the
 * tracking page's anti-enumeration posture (a wrong contact for a REAL order
 * renders the identical generic message a nonexistent order number would).
 *
 * A NEW file (not an extension of `p1-dod.spec.ts`): P1's suite already ends
 * at a fully launched, working store — this suite starts from a DIFFERENT
 * premise (an already-launched tenant with a product and shipping
 * configured) and walks a shopper+merchant journey that has nothing to do
 * with P1's own signup/onboarding/staff-invite assertions. Concatenating the
 * two into one file would just make an already-long suite harder to read for
 * no shared setup benefit (the two flows share no state).
 *
 * Fixture strategy — Prisma-seeded, not a full P1 UI walk: this suite still
 * drives ONE real UI action for auth (`/registro`, the same signup form
 * `p1-dod.spec.ts` uses) so the browser holds a genuine better-auth session
 * cookie, but then provisions the Tenant/TenantDomain/Membership/Product/
 * shipping-settings rows DIRECTLY via `@ventia/db`'s `platformDb`, bypassing
 * the onboarding wizard entirely. Two things make this safe and appropriate
 * here (confirmed by reading the actual gates, not assumed):
 *   - `apps/admin/app/(app)/layout.tsx`'s gate and
 *     `services/api/src/admin/admin-session.guard.ts` only require a
 *     session + an active (non-null-tenantId, non-platform_admin) Membership
 *     row — neither cares about `tenant.status`, an onboarding-completion
 *     flag, or `User.emailVerified`. Setting `Tenant.status: 'live'` and a
 *     `Membership` row directly is exactly as valid to those gates as
 *     walking the wizard and clicking "Lanzar tienda" would be.
 *   - `services/api/test/orders-transitions.test.ts` and
 *     `test/checkout.test.ts` already establish this exact "seed
 *     Tenant/TenantDomain/Product directly via Prisma, skip the HTTP/UI path
 *     that would normally produce them" convention at the API-test layer —
 *     this suite is the same convention one layer up, for a browser e2e.
 * Re-running P1's entire wizard (10-product CSV import, branding, payments
 * step, email verification, launch) here would re-prove ground P1's own DoD
 * suite already covers, at a real cost (that suite alone runs for minutes)
 * — for a suite whose actual subject is P2's cart/checkout/fulfillment/
 * tracking flow, not onboarding.
 *
 * Run via `bash scripts/e2e.sh` (NOT directly) — same reasoning as
 * `p1-dod.spec.ts`: that script boots API/admin/storefront against the
 * running dev stack and runs every spec in this directory through Caddy.
 * `platformDb` (imported above) reads `DATABASE_URL` from the environment at
 * module-load time, which `scripts/e2e.sh` already exports before invoking
 * Playwright — no separate env wiring needed here.
 */

const ts = Date.now();
const OWNER_EMAIL = `p2dod-owner-${ts}@demo.co`;
const OWNER_PASSWORD = 'Dod-Secreta-2026!';
const STORE_NAME = `Tienda P2 DoD ${ts}`;
// Mirrors @ventia/core's slugify(STORE_NAME) closely enough for a
// ts-suffixed, already-unique, already-lowercase-safe literal — this suite
// picks the slug itself (unlike p1-dod.spec.ts, which derives it from a
// UI-entered store name) since the tenant is seeded directly, not created by
// walking the "create store" wizard step.
const STORE_SLUG = `tienda-p2-dod-${ts}`;
const PRODUCT_NAME = `Producto P2 DoD ${ts}`;
const PRODUCT_SLUG = `producto-p2-dod-${ts}`;
const PRODUCT_PRICE_CENTS = 89_900;
const SHIPPING_METHOD_ID = 'flat-1';
const SHIPPING_LABEL = 'Envío estándar';
const SHIPPING_PRICE_CENTS = 12_000;

// The checkout contact — deliberately a DIFFERENT email than OWNER_EMAIL:
// the owner and the shopper are different people in the real flow this test
// models (a merchant fulfilling a stranger's order), and reusing OWNER_EMAIL
// would make the later "wrong contact" assertion trivially pass for the
// wrong reason (mixing up the owner's own login with the order's contact).
const SHOPPER_EMAIL = `p2dod-comprador-${ts}@demo.co`;
const SHOPPER_PHONE = '3011234567';
const WRONG_CONTACT = `no-es-el-comprador-${ts}@demo.co`;

const CARRIER = 'Servientrega';
const TRACKING_NUMBER = `TRK-${ts}`;

/**
 * Retries `perform` (a fill-then-click, or just a click) up to `attempts`
 * times until `check` succeeds. Local copy of `p1-dod.spec.ts`'s identical
 * helper (see that file's doc comment for the full two-Next.js-dev-mode-race
 * rationale this guards against) — duplicated rather than imported, matching
 * this codebase's established per-file-copy convention for small test/prod
 * helpers with no shared-package boundary (see e.g.
 * `services/api/src/checkout/order-tracking.controller.ts`'s own `asRecord`
 * doc comment for the same reasoning applied elsewhere in this repo).
 */
async function retryUntil(
  perform: () => Promise<void>,
  check: () => Promise<void>,
  opts: { attempts?: number; reloadOnRetry?: Page } = {},
): Promise<void> {
  const attempts = opts.attempts ?? 4;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await perform();
    try {
      await check();
      return;
    } catch (e) {
      if (attempt === attempts) throw e;
      if (opts.reloadOnRetry) await opts.reloadOnRetry.reload();
    }
  }
}

function urlCheck(page: Page, expected: string | RegExp, fallbackUrl: string, timeoutMs = 8_000) {
  return async () => {
    try {
      await page.waitForURL(expected, { timeout: timeoutMs });
    } catch {
      await page.goto(fallbackUrl);
    }
    await expect(page).toHaveURL(expected);
  };
}

function visibleCheck(locator: Locator, timeoutMs = 6_000) {
  return () => locator.waitFor({ state: 'visible', timeout: timeoutMs });
}

/** `VNT-####` customer-facing order-number prefix — same literal convention
 * as every other module that renders one (storefront's confirmation/rastrear
 * pages, the admin orders pages, the mailer) — local copy per this
 * codebase's established no-shared-package convention. */
function vnt(orderNumber: number): string {
  return `VNT-${orderNumber}`;
}

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await platformDb.$disconnect();
});

test.describe('P2 Definition-of-Done', () => {
  test('full vertical slice: browse -> cart -> COD checkout -> admin fulfillment -> public tracking', async ({
    page,
    context,
  }) => {
    let orderNumber = 0;

    await test.step('seed: real UI signup for a genuine session cookie, then provision a live tenant + product + shipping directly via Prisma', async () => {
      await page.goto('/registro');
      await retryUntil(
        async () => {
          await page.getByLabel('Nombre').fill('Owner P2 Dod');
          await page.getByLabel('Correo').fill(OWNER_EMAIL);
          await page.getByLabel('Contraseña').fill(OWNER_PASSWORD);
          await page.getByRole('button', { name: 'Crear cuenta' }).click();
        },
        urlCheck(page, /\/onboarding/, '/onboarding'),
      );

      const user = await platformDb.user.findUniqueOrThrow({ where: { email: OWNER_EMAIL } });

      const tenant = await platformDb.tenant.create({
        data: {
          slug: STORE_SLUG,
          name: STORE_NAME,
          status: 'live',
          settings: {
            payments: { codEnabled: true },
            shipping: {
              methods: [
                {
                  id: SHIPPING_METHOD_ID,
                  type: 'flat',
                  label: SHIPPING_LABEL,
                  priceCents: SHIPPING_PRICE_CENTS,
                  enabled: true,
                },
              ],
            },
          },
        },
      });

      await platformDb.tenantDomain.create({
        data: { tenantId: tenant.id, domain: `${STORE_SLUG}.ventia.localhost`, isPrimary: true },
      });

      await platformDb.membership.create({
        data: { userId: user.id, tenantId: tenant.id, role: 'owner' },
      });

      await platformDb.product.create({
        data: {
          tenantId: tenant.id,
          name: PRODUCT_NAME,
          slug: PRODUCT_SLUG,
          priceCents: PRODUCT_PRICE_CENTS,
          status: 'active',
          stock: 50,
        },
      });
    });

    const storePage = await context.newPage();

    await test.step('storefront: home resolves the seeded tenant and lists the product', async () => {
      await storePage.goto(`http://${STORE_SLUG}.ventia.localhost`);
      await expect(storePage.getByRole('heading', { name: STORE_NAME })).toBeVisible();
      await expect(storePage.locator(`a[href="/productos/${PRODUCT_SLUG}"]`)).toBeVisible();
    });

    await test.step('storefront: PDP -> add to cart -> drawer updates', async () => {
      await storePage.locator(`a[href="/productos/${PRODUCT_SLUG}"]`).click();
      await expect(storePage).toHaveURL(new RegExp(`/productos/${PRODUCT_SLUG}$`));
      await expect(storePage.getByRole('heading', { name: PRODUCT_NAME })).toBeVisible();

      // The drawer's own "Ver carrito" action and the always-visible fixed
      // cart-icon trigger (`aria-label="Ver carrito"`) share the exact same
      // accessible NAME, but not the same ROLE: the drawer's is a `Button
      // href="/carrito"` (renders as a real `<a>`, per `Button`'s own
      // href-renders-as-anchor convention — see cart-drawer.tsx's doc
      // comment), so it's a "link", while the fixed trigger is a real
      // `<button aria-label="Ver carrito">`. Scoped to the native `<dialog>`
      // element (`CartDrawer`'s `Dialog`, the only one on this page) too,
      // matching `p1-dod.spec.ts`'s own `nav`-scoped "Importar CSV" link
      // lookup for the same "disambiguate by scope" reasoning.
      const cartDialog = storePage.locator('dialog');
      const verCarritoButton = cartDialog.getByRole('link', { name: 'Ver carrito' });

      // First interactive click on this freshly-loaded route — same
      // first-compile/hydration race p1-dod.spec.ts's retryUntil doc
      // comment describes; the drawer's "Ver carrito" button becoming
      // visible is proof the add succeeded and the drawer opened.
      await retryUntil(
        async () => {
          await storePage.getByRole('button', { name: 'Agregar al carrito' }).click();
        },
        visibleCheck(verCarritoButton),
        { attempts: 6, reloadOnRetry: storePage },
      );
      // The drawer's own line item confirms it's THIS product, not just any
      // dialog opening.
      await expect(cartDialog.getByText(PRODUCT_NAME).first()).toBeVisible();

      await verCarritoButton.click();
      await expect(storePage).toHaveURL(/\/carrito$/);
    });

    await test.step('storefront: /carrito shows the line item; proceed to /checkout', async () => {
      await expect(storePage.getByRole('cell', { name: PRODUCT_NAME })).toBeVisible();
      await storePage.getByRole('link', { name: 'Ir a pagar' }).click();
      await expect(storePage).toHaveURL(/\/checkout$/);
    });

    await test.step('storefront: fill the COD checkout form (Colombian address, configured shipping method) and submit', async () => {
      await expect(storePage.getByRole('heading', { name: 'Pagar' })).toBeVisible();

      await storePage.getByLabel('Correo electrónico').fill(SHOPPER_EMAIL);
      await storePage.getByLabel('Teléfono').fill(SHOPPER_PHONE);
      await storePage.getByLabel('Nombre completo').fill('Compradora P2 Dod');

      // Bogotá, D.C. is departamento code '11' — the same DIVIPOLA
      // entry/value the API's own test/checkout.test.ts fixture
      // (BOGOTA_ADDRESS) uses; municipioName matches by NAME (no separate
      // stable id, per checkout-form.ts's own doc comment), and "Bogotá,
      // D.C." is both the departamento's and its own municipio's name.
      await storePage.getByLabel('Departamento').selectOption({ label: 'Bogotá, D.C.' });
      await storePage.getByLabel('Municipio').selectOption({ label: 'Bogotá, D.C.' });
      await storePage.getByLabel('Dirección').fill('Calle 1 # 2-34');
      await storePage.getByLabel('Barrio (opcional)').fill('Barrio Centro');

      // The shipping radiogroup only populates after the async
      // fetchShippingQuote(departamentoCode) call resolves — Playwright's
      // own actionability wait on the radio input handles that, no manual
      // sleep needed.
      const shippingRadio = storePage.locator(`input[type="radio"][value="${SHIPPING_METHOD_ID}"]`);
      await shippingRadio.check();

      // Choose the payment method explicitly. This step did not exist when
      // this spec was written, because COD was then effectively the only
      // option; P3 added Wompi/Mercado Pago/ePayco alongside it, so the
      // radiogroup now starts with NOTHING selected and the form stops at
      // "Selecciona un método de pago." — which is the correct behaviour (a
      // shopper should never be silently defaulted into how they pay), so the
      // spec is what was out of date, not the app.
      //
      // 'cod' specifically: this test's subject is the COD vertical slice, and
      // the online providers would redirect off-site to a gateway rather than
      // reaching the confirmation page asserted below.
      await storePage.locator('input[type="radio"][name="paymentMethod"][value="cod"]').check();

      await storePage.getByRole('button', { name: 'Confirmar pedido' }).click();
      await storePage.waitForURL(/\/checkout\/confirmacion\/\d+$/, { timeout: 20_000 });

      const match = storePage.url().match(/\/confirmacion\/(\d+)$/);
      if (!match) throw new Error(`expected a numeric order number in the confirmation URL, got ${storePage.url()}`);
      orderNumber = Number(match[1]);
      expect(Number.isInteger(orderNumber) && orderNumber > 0).toBe(true);

      await expect(storePage.getByText(`Pedido #${vnt(orderNumber)}`)).toBeVisible();
    });

    await test.step('admin: confirm -> preparing -> shipped (carrier + tracking) -> delivered, driving the real /pedidos UI', async () => {
      // Reuses `page` (the SAME browser context/cookie the /registro signup
      // above authenticated) rather than a fresh login — the brief's own
      // "log in (or reuse a seeded owner session)" bullet explicitly allows
      // this, and the session is genuine (obtained via the real signup
      // form), just fast-forwarded to a live tenant via the Prisma seed
      // above rather than via the onboarding wizard.
      const orderLink = page.getByRole('link', { name: vnt(orderNumber) });
      await retryUntil(
        async () => {
          await page.goto('/pedidos');
        },
        visibleCheck(orderLink),
        { attempts: 6 },
      );
      await orderLink.click();
      await expect(page).toHaveURL(/\/pedidos\/[0-9a-f-]+$/);
      await expect(page.getByRole('heading', { name: vnt(orderNumber) })).toBeVisible();

      const confirmButton = page.getByRole('button', { name: 'Confirmar pedido' });
      const preparingButton = page.getByRole('button', { name: 'Marcar en preparación' });
      await retryUntil(
        async () => {
          await confirmButton.click();
        },
        visibleCheck(preparingButton),
        { attempts: 4 },
      );

      const shippedButton = page.getByRole('button', { name: 'Marcar enviado' });
      await preparingButton.click();
      await expect(shippedButton).toBeVisible();

      await shippedButton.click();
      await page.getByLabel('Transportadora').fill(CARRIER);
      await page.getByLabel('Número de guía').fill(TRACKING_NUMBER);
      const deliveredButton = page.getByRole('button', { name: 'Marcar entregado' });
      await page.getByRole('button', { name: 'Confirmar envío' }).click();
      await expect(deliveredButton).toBeVisible();

      await deliveredButton.click();
      await expect(page.getByText('Entregado', { exact: true }).first()).toBeVisible();

      // The timeline's shipped event is the only place the carrier/tracking
      // number is visible again after ShippedForm (see
      // pedidos/[id]/page.tsx's `eventShipment` doc comment) — confirms the
      // admin side genuinely recorded what was typed above, not just that
      // the status flipped.
      await expect(page.getByText(`Transportadora: ${CARRIER} · Guía: ${TRACKING_NUMBER}`)).toBeVisible();
    });

    await test.step('storefront: /rastrear the same order by number + correct email shows Entregado, the carrier/tracking number, and a timeline', async () => {
      // First-ever visit to /rastrear in this run: same first-compile/
      // hydration race as every other freshly-loaded route in this suite
      // (see the retryUntil doc comment above) — `perform` re-navigates from
      // scratch on every attempt (rather than using `reloadOnRetry`), which
      // is safe here because a tracking lookup is a read-only GET with no
      // side effects to duplicate, unlike a form that creates/mutates data.
      //
      // Absolute URL, not a relative `storePage.goto('/rastrear')`:
      // playwright.config.ts's `baseURL` is `http://admin.ventia.localhost`
      // (this suite's OTHER page, `page`, lives there) — a relative `.goto()`
      // on ANY page resolves against that config-level baseURL, not the
      // calling page's own current origin, so a relative call here would
      // silently 404 against the admin app instead of reaching the
      // storefront's tenant subdomain `storePage` is actually on. Every
      // earlier `storePage` navigation avoided this by either using an
      // absolute URL (the very first `.goto()` above) or a real link
      // `.click()` (which follows its own `href`, unaffected by `baseURL`).
      const resultHeading = storePage.getByRole('heading', { name: `Pedido #${vnt(orderNumber)}` });
      await retryUntil(
        async () => {
          await storePage.goto(`http://${STORE_SLUG}.ventia.localhost/rastrear`);
          await storePage.getByLabel('Número de pedido').fill(String(orderNumber));
          await storePage.getByLabel('Correo o teléfono').fill(SHOPPER_EMAIL);
          await storePage.getByRole('button', { name: 'Buscar pedido' }).click();
        },
        visibleCheck(resultHeading),
        { attempts: 6 },
      );
      await expect(storePage.getByText('Entregado', { exact: true })).toBeVisible();
      await expect(
        storePage.getByText(`Transportadora: ${CARRIER} — Guía: ${TRACKING_NUMBER}`),
      ).toBeVisible();

      // Exactly the "created" event plus one status_changed event per
      // transition this test just drove through the admin UI (confirm,
      // preparing, shipped, delivered) = 5 timeline entries. The `<ul>` is
      // the heading's next sibling inside the same wrapping `<div>` (see
      // `app/rastrear/page.tsx`), not a descendant of the heading itself,
      // hence the `following-sibling` lookup rather than `.filter({has})`.
      const historyHeading = storePage.getByRole('heading', { name: 'Historial' });
      await expect(historyHeading).toBeVisible();
      const timelineList = historyHeading.locator('xpath=following-sibling::ul[1]');
      await expect(timelineList.locator('li')).toHaveCount(5);
    });

    await test.step('storefront: /rastrear the SAME real order number with a WRONG contact renders the identical generic message a nonexistent order number would', async () => {
      // Scoped to `main`, not a bare `storePage.getByRole('alert')`: the
      // App Router injects its own hidden route-change announcer on every
      // page (`<div role="alert" aria-live="assertive"
      // id="__next-route-announcer__">`, outside the page's own `<main>`),
      // which also matches an unscoped `role=alert` query — a bare locator
      // resolves to BOTH elements (a genuine strict-mode violation, caught
      // by actually running this suite, not assumed), even though only one
      // of them is this app's own error banner. `rastrear/page.tsx` wraps
      // its entire render in `<main>`, so scoping there reliably excludes
      // the framework's own announcer.
      const wrongContactAlert = storePage.locator('main').getByRole('alert');
      await retryUntil(
        async () => {
          await storePage.goto(`http://${STORE_SLUG}.ventia.localhost/rastrear`);
          await storePage.getByLabel('Número de pedido').fill(String(orderNumber));
          await storePage.getByLabel('Correo o teléfono').fill(WRONG_CONTACT);
          await storePage.getByRole('button', { name: 'Buscar pedido' }).click();
        },
        visibleCheck(wrongContactAlert),
        { attempts: 6 },
      );
      const wrongContactMessage = await wrongContactAlert.textContent();

      // No result card should render for a failed lookup — same "not a
      // different-looking screen" assertion the brief's manual-smoke-test
      // bullet calls for, folded into this same spec rather than a separate
      // manual step (a real Playwright assertion is strictly stronger than
      // an eyeballed manual check here).
      await expect(storePage.getByRole('heading', { name: `Pedido #${vnt(orderNumber)}` })).toHaveCount(0);

      // A genuinely nonexistent order number (this run's real orderNumber
      // plus a large offset, astronomically unlikely to collide with any
      // other order ever created in this dev DB) must render the EXACT SAME
      // text — not just "also an error", but byte-for-byte identical wording
      // — proving the backend's deliberate wrong-contact/nonexistent-order
      // collapse (see order-tracking.controller.ts's doc comment) is
      // faithfully surfaced by the storefront UI with no distinguishing
      // wording of its own.
      // Same `main`-scoped locator as `wrongContactAlert` above, same reason
      // (excluding the App Router's own route-announcer element).
      const nonexistentAlert = storePage.locator('main').getByRole('alert');
      await retryUntil(
        async () => {
          await storePage.goto(`http://${STORE_SLUG}.ventia.localhost/rastrear`);
          await storePage.getByLabel('Número de pedido').fill(String(orderNumber + 9_000_000));
          await storePage.getByLabel('Correo o teléfono').fill(WRONG_CONTACT);
          await storePage.getByRole('button', { name: 'Buscar pedido' }).click();
        },
        visibleCheck(nonexistentAlert),
        { attempts: 6 },
      );
      const nonexistentMessage = await nonexistentAlert.textContent();

      expect(nonexistentMessage).toBe(wrongContactMessage);
      expect(nonexistentMessage).toMatch(/no encontramos ese pedido/i);
    });

    await storePage.close();
  });
});
