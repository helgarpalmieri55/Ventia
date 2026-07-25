import { readFileSync } from 'node:fs';
import { test, expect, type Locator, type Page } from '@playwright/test';

/**
 * P1 Definition-of-Done e2e (Task 8's binding contract): a fresh merchant
 * signs up, runs the onboarding wizard (store info, branding, a 10-product
 * CSV import, cash-on-delivery), verifies their email, launches the store,
 * and the storefront resolves it by subdomain — then a second person is
 * invited as staff, accepts, and hits the owner-only/staff-shared boundary.
 *
 * Run via `bash scripts/e2e.sh` (NOT directly): that script boots the API,
 * admin, and storefront dev servers against the already-running Docker dev
 * stack, waits for all three, and only then runs this suite through Caddy
 * (`http://admin.ventia.localhost`, this file's baseURL — see
 * playwright.config.ts).
 *
 * Email verification / staff invite hook — READ BEFORE CHANGING: there is no
 * dev-only API backdoor for this (a real one was explicitly rejected — see
 * the task brief). The API's `ConsoleMailer` (services/api/src/mailer/
 * mailer.ts) logs every outbound email — `[mail] to=<addr> subject=...`
 * followed by the body, verification/invite links included — to its own
 * stdout instead of sending anything real. `scripts/e2e.sh` tees that
 * stdout to a file and exports its path as `E2E_API_LOG`; `waitForMailUrl`/
 * `waitForMailToken` below just poll that file for the line this test's own
 * signup/invite action just produced, exactly like a developer eyeballing
 * the API's terminal would.
 */

const ts = Date.now();
const OWNER_EMAIL = `dod-${ts}@demo.co`;
const OWNER_PASSWORD = 'Dod-Secreta-2026!';
const STAFF_EMAIL = `staff-dod-${ts}@demo.co`;
const STAFF_PASSWORD = 'Staff-Secreta-2026!';
const STORE_NAME = `Tienda DoD ${ts}`;
// Mirrors @ventia/core's slugify(STORE_NAME): lowercase, diacritics
// stripped, non-alnum runs collapsed to single hyphens.
const STORE_SLUG = `tienda-dod-${ts}`;
const PRODUCT_COUNT = 10;

function apiLogPath(): string {
  const path = process.env.E2E_API_LOG;
  if (!path) {
    throw new Error(
      'E2E_API_LOG is not set — this suite reads the API dev server\'s console-mailer output ' +
        'from a log file and must be run via `bash scripts/e2e.sh`, not `playwright test` directly.',
    );
  }
  return path;
}

/** Polls the API log file for the LAST `[mail] to=<toEmail>` line, then
 * extracts whatever `extract` finds in the text immediately following it
 * (the mailer's `send()` call logs the whole message body right after the
 * to=/subject= line — see mailer.ts's `ConsoleMailer`). Polls rather than
 * reading once: the log write and this read are two independent processes,
 * so there's no guarantee the line has been flushed to disk the instant the
 * UI action that triggered the send resolves. */
async function waitForMailMatch(toEmail: string, extract: RegExp, timeoutMs = 20_000): Promise<string> {
  const path = apiLogPath();
  const marker = `[mail] to=${toEmail}`;
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  while (Date.now() < deadline) {
    lastText = readFileSync(path, 'utf8');
    const idx = lastText.lastIndexOf(marker);
    if (idx !== -1) {
      const match = lastText.slice(idx).match(extract);
      if (match) return match[1] ?? match[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for a mail matching ${extract} to ${toEmail} in ${path}.\n` +
      `Log tail:\n${lastText.slice(-2000)}`,
  );
}

/** The verification email's body is `...enlace:\n${url}\n\n...` (see
 * services/api/src/auth/auth.ts) — the first absolute URL after the to=
 * marker line. */
function waitForVerificationUrl(toEmail: string): Promise<string> {
  return waitForMailMatch(toEmail, /(https?:\/\/\S+)/);
}

/** The staff-invite email embeds `...token=${raw}` (48 hex chars — see
 * staff.service.ts) in a link on the API's own domain
 * (`${apiUrl}/v1/staff/accept?token=...`), which is a POST-only endpoint and
 * not something a browser can just GET — the admin app's actual accept flow
 * is the client-rendered `/aceptar-invitacion?token=...` page, so this only
 * pulls the token out of the emailed link rather than following it as-is. */
function waitForInviteToken(toEmail: string): Promise<string> {
  return waitForMailMatch(toEmail, /token=([0-9a-f]{48})/);
}

/** A 10-row CSV using only the columns the binding contract calls out
 * (name, price_cents, sku, stock, status=active) — every other
 * csvProductRowSchema column is optional (see packages/core/src/
 * catalog-schemas.ts) and defaults sensibly (draft description, 19% tax,
 * etc.) when omitted. */
function buildProductsCsv(): string {
  const header = 'name,price_cents,sku,stock,status';
  const rows = Array.from({ length: PRODUCT_COUNT }, (_, i) => {
    const n = i + 1;
    const name = `Producto DoD ${ts} ${String(n).padStart(2, '0')}`;
    const sku = `DOD-${ts}-${String(n).padStart(2, '0')}`;
    const priceCents = 1_000_000 + n * 5_000;
    return `${name},${priceCents},${sku},25,active`;
  });
  return [header, ...rows].join('\n');
}

const PRODUCTS_CSV = buildProductsCsv();
const FIFTH_PRODUCT_NAME = `Producto DoD ${ts} 05`;

/**
 * Retries `perform` (a fill-then-click, or just a click) up to `attempts`
 * times until `check` succeeds, per attempt capped at `timeoutMs`.
 *
 * Why this exists — two independent Next.js 15 dev-mode races, both
 * observed repeatedly in this environment (never in the app's own code) on
 * the FIRST interactive element of a freshly-loaded route:
 *
 *  1. Sign-up/sign-in/invite-accept finish with `router.push(url);
 *     router.refresh();` — a client-side, RSC-fetch-based soft navigation
 *     that has been seen to simply hang forever, wedging the test behind
 *     one dead `await` with no error.
 *  2. A route's client JS can still be finishing hydration in the instant
 *     right after its HTML/RSC payload paints — a click that lands in that
 *     window never reaches React at all. For a plain `onClick` button this
 *     is a silent no-op (safe to just click again); for a `<button
 *     type="submit">` inside a `<form>` it instead falls through to the
 *     BROWSER's native form submission (no JS listener attached yet to
 *     preventDefault it), which does a real GET reload of the current URL
 *     and wipes all client-side wizard state — exactly what was seen at the
 *     "create store" step. A third, rarer variant of the same family: this
 *     environment's dev server has been observed recompiling the SAME route
 *     repeatedly in a tight loop with no request driving it (a watcher
 *     misfire, not anything this app's code triggers), which can keep
 *     resetting component state out from under a click for several seconds
 *     straight — `reloadOnRetry` (below) is the escape hatch for that case:
 *     a hard reload gives the page a clean, one-shot hydration instead of
 *     landing in the middle of an active rebuild storm.
 *
 * Retrying the WHOLE `perform` (re-filling every field, not just
 * re-clicking) is what makes this safe against #2's reload case. Every
 * `check` here is either a URL wait or a heading/text visibility wait, with
 * a generous per-attempt timeout, so a merely-slow-but-succeeding first
 * attempt is not mistaken for a dropped click and retried into a duplicate
 * submission.
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

/** `check` variant for a soft-navigation that may hang (case #1 above): a
 * bounded wait for the expected URL, falling back to a hard `page.goto` of
 * the same destination if the client-side redirect never completes. Safe
 * regardless of cause — by the time the click handler reaches
 * `router.push`, the mutation it was gated on already succeeded
 * server-side, so forcing the same URL is never re-triggering it. */
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

/** `check` variant for a same-page state change (case #2 above): the
 * expected element becomes visible within `timeoutMs`. */
function visibleCheck(locator: Locator, timeoutMs = 6_000) {
  return () => locator.waitFor({ state: 'visible', timeout: timeoutMs });
}

test.describe.configure({ mode: 'serial' });

test.describe('P1 Definition-of-Done', () => {
  test('owner: sign up, wizard (store info, branding, CSV import, COD), verify email, launch; storefront resolves the store', async ({
    page,
    context,
  }) => {
    await test.step('sign up', async () => {
      await page.goto('/registro');
      await retryUntil(
        async () => {
          await page.getByLabel('Nombre').fill('Owner Dod');
          await page.getByLabel('Correo').fill(OWNER_EMAIL);
          await page.getByLabel('Contraseña').fill(OWNER_PASSWORD);
          await page.getByRole('button', { name: 'Crear cuenta' }).click();
        },
        urlCheck(page, /\/onboarding/, '/onboarding'),
      );
    });

    await test.step('create store', async () => {
      const storeInfoHeading = page.getByRole('heading', { name: 'Información de tu tienda' });
      await expect(page.getByRole('heading', { name: 'Crea tu tienda' })).toBeVisible();
      await retryUntil(async () => {
        await page.getByLabel('Nombre de tu tienda').fill(STORE_NAME);
        await page.getByRole('button', { name: 'Crear tienda' }).click();
      }, visibleCheck(storeInfoHeading));
    });

    await test.step('store_info step (contactEmail is required for the launch checklist)', async () => {
      const brandingHeading = page.getByRole('heading', { name: 'La marca de tu tienda' });
      await retryUntil(async () => {
        await page.getByLabel('Correo de contacto').fill('contacto@tiendadod.co');
        await page.getByRole('button', { name: 'Continuar' }).click();
      }, visibleCheck(brandingHeading));
    });

    await test.step('branding step (defaults are fine)', async () => {
      const productsHeading = page.getByRole('heading', { name: 'Agrega tus productos' });
      await retryUntil(async () => {
        await page.getByRole('button', { name: 'Continuar' }).click();
      }, visibleCheck(productsHeading));
    });

    await test.step('products step: import a 10-product CSV via /importar instead of the one-by-one form', async () => {
      await page.getByRole('link', { name: 'Ir a Productos' }).click();
      await expect(page.getByRole('heading', { name: 'Productos' })).toBeVisible();

      // Scoped to the sidebar <nav> — the empty products list ALSO renders
      // an inline "Importar CSV" button (same label, same destination), so
      // an unscoped role query here would hit Playwright's strict-mode
      // ambiguity check.
      await page.locator('nav').getByRole('link', { name: 'Importar CSV' }).click();
      await expect(page).toHaveURL(/\/importar/);
      await expect(page.getByRole('heading', { name: 'Importar productos desde CSV' })).toBeVisible();

      // First interactive click on this freshly-loaded route — see
      // retryUntil's doc comment for why this needs the retry treatment.
      // `reloadOnRetry` is safe here specifically because /importar always
      // starts from the same inputMode='file' default — a reload can never
      // land this retry loop on a different, unexpected state the way it
      // could mid-wizard.
      const csvTextarea = page.getByPlaceholder('Pega aquí el contenido del CSV');
      await retryUntil(
        async () => {
          await page.getByRole('button', { name: 'Pegar texto' }).click();
        },
        visibleCheck(csvTextarea),
        { attempts: 8, reloadOnRetry: page },
      );
      await csvTextarea.fill(PRODUCTS_CSV);
      await page.getByRole('button', { name: 'Validar archivo' }).click();

      // The outer Card also carries a `rounded-md` class, so a bare
      // `div.rounded-md` filter matches BOTH it and the inner SummaryStat —
      // scoped to SummaryStat's exact class combination to disambiguate.
      const nuevosStat = page.locator('div.flex.flex-col.gap-1.rounded-md', { hasText: 'Nuevos' });
      const erroresStat = page.locator('div.flex.flex-col.gap-1.rounded-md', { hasText: 'Con errores' });
      await expect(nuevosStat).toContainText(String(PRODUCT_COUNT));
      await expect(erroresStat).toContainText('0');

      await page.getByRole('button', { name: 'Importar productos' }).click();
      await expect(
        page.getByText(`Se crearon ${PRODUCT_COUNT} productos y se actualizaron 0.`),
      ).toBeVisible();

      await page.getByRole('link', { name: 'Ver productos' }).click();
      await expect(page).toHaveURL(/\/productos/);
    });

    await test.step('products check: /productos shows the 10 imported products (search one by name)', async () => {
      // "Ver productos" landed us back on /productos — a fresh navigation
      // from /importar, so the search form's first submit needs the retry
      // treatment again.
      const productLink = page.getByRole('link', { name: FIFTH_PRODUCT_NAME });
      await retryUntil(
        async () => {
          await page.getByPlaceholder('Buscar por nombre o SKU').fill(FIFTH_PRODUCT_NAME);
          await page.getByRole('button', { name: 'Buscar' }).click();
        },
        visibleCheck(productLink),
        { attempts: 6, reloadOnRetry: page },
      );
    });

    await test.step('back to onboarding: mark the products step done', async () => {
      await page.goto('/onboarding');
      await expect(page.getByRole('heading', { name: 'Agrega tus productos' })).toBeVisible();
      await expect(page.getByText(`Tienes ${PRODUCT_COUNT} productos activos.`)).toBeVisible();
      const paymentsHeading = page.getByRole('heading', { name: 'Formas de pago' });
      await retryUntil(async () => {
        await page.getByRole('button', { name: 'Ya agregué mis productos' }).click();
      }, visibleCheck(paymentsHeading));
    });

    await test.step('payments step: enable COD', async () => {
      // A brand-new tenant's saved `codEnabled` is `false` (see
      // settings.controller.ts's `toResponse` — `payments.codEnabled ===
      // true`), and PaymentsStep's `initialCodEnabled ?? true` only falls
      // back to `true` on null/undefined, not on an explicit `false` — so
      // this step's checkbox starts UNCHECKED, not checked, for a fresh
      // store. Check it explicitly rather than assuming a default.
      const codCheckbox = page.getByLabel('Aceptar pago contraentrega');
      await expect(codCheckbox).not.toBeChecked();
      await codCheckbox.check();
      const checklistHeading = page.getByRole('heading', { name: 'Lista de lanzamiento' });
      await retryUntil(async () => {
        await page.getByRole('button', { name: 'Continuar' }).click();
      }, visibleCheck(checklistHeading));
    });

    await test.step('verify email via the console-mailer log hook, then launch', async () => {
      // Email verification is PENDING at this point (sendOnSignUp fired on
      // registro, nobody has followed the link yet) — visit it in a second
      // tab so the wizard tab's state/scroll position is undisturbed.
      const verificationUrl = await waitForVerificationUrl(OWNER_EMAIL);
      const verifyPage = await context.newPage();
      await verifyPage.goto(verificationUrl);
      await verifyPage.close();

      await page.getByRole('button', { name: 'Actualizar' }).click();
      // Every checklist item should read "Listo" now (storeInfo, verified
      // email, active product, COD) — none left "Pendiente".
      await expect(page.getByText('Pendiente', { exact: true })).toHaveCount(0);

      await page.getByRole('button', { name: 'Lanzar tienda' }).click();
      await expect(page.getByText('Tu tienda ya está en línea.')).toBeVisible();
      await expect(page.getByRole('link', { name: `http://${STORE_SLUG}.ventia.localhost` })).toBeVisible();
    });

    await test.step('storefront resolves the store by subdomain and shows its name', async () => {
      const storePage = await context.newPage();
      await storePage.goto(`http://${STORE_SLUG}.ventia.localhost`);
      await expect(storePage.getByRole('heading', { name: STORE_NAME })).toBeVisible();
      await storePage.close();
    });
  });

  test('staff: invited, accepts, sees /productos but is blocked from /configuracion', async ({ page, browser }) => {
    await test.step('owner invites staff from /equipo', async () => {
      await page.goto('/login');
      await retryUntil(async () => {
        await page.getByLabel('Correo').fill(OWNER_EMAIL);
        await page.getByLabel('Contraseña').fill(OWNER_PASSWORD);
        await page.getByRole('button', { name: 'Ingresar' }).click();
      }, urlCheck(page, '/', '/'));

      await page.goto('/equipo');
      const inviteDialogHeading = page.getByRole('heading', { name: 'Invitar a alguien al equipo' });
      await retryUntil(
        async () => {
          await page.getByRole('button', { name: 'Invitar' }).click();
        },
        visibleCheck(inviteDialogHeading),
        { attempts: 6, reloadOnRetry: page },
      );

      await page.getByLabel('Correo').fill(STAFF_EMAIL);
      await page.getByRole('button', { name: 'Enviar invitación' }).click();
      // Plain getByText('Invitación enviada') also substring-matches the
      // (unrelated, hidden) revoke-invite dialog's "¿Revocar la invitación
      // enviada a ...?" copy case-insensitively — scoped to the heading role
      // to disambiguate.
      await expect(page.getByRole('heading', { name: 'Invitación enviada' })).toBeVisible();
    });

    const inviteToken = await waitForInviteToken(STAFF_EMAIL);

    const staffContext = await browser.newContext();
    try {
      const staffPage = await staffContext.newPage();

      await test.step('staff signs up, then accepts the invite', async () => {
        await staffPage.goto('/registro');
        await retryUntil(
          async () => {
            await staffPage.getByLabel('Nombre').fill('Staff Dod');
            await staffPage.getByLabel('Correo').fill(STAFF_EMAIL);
            await staffPage.getByLabel('Contraseña').fill(STAFF_PASSWORD);
            await staffPage.getByRole('button', { name: 'Crear cuenta' }).click();
          },
          urlCheck(staffPage, /\/onboarding/, '/onboarding'),
        );

        await staffPage.goto(`/aceptar-invitacion?token=${inviteToken}`);
        await expect(staffPage.getByRole('heading', { name: 'Aceptar invitación' })).toBeVisible();
        await retryUntil(async () => {
          await staffPage.getByRole('button', { name: 'Aceptar invitación' }).click();
        }, urlCheck(staffPage, '/', '/'));
      });

      await test.step('staff sees /productos but is blocked from /configuracion', async () => {
        await staffPage.goto('/productos');
        await expect(staffPage.getByRole('heading', { name: 'Productos' })).toBeVisible();

        await staffPage.goto('/configuracion');
        await expect(staffPage.getByText('No tienes permisos para esta acción.')).toBeVisible();
      });
    } finally {
      await staffContext.close();
    }
  });
});
