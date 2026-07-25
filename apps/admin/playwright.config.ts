import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * P1 Definition-of-Done e2e (Task 8): a single chromium project against the
 * real dev stack (Caddy + api + admin + storefront — see scripts/e2e.sh),
 * not a component harness. No `playwright install` here or in CI for this
 * suite: the runtime image preinstalls chromium under
 * `PLAYWRIGHT_BROWSERS_PATH` (`/opt/pw-browsers`), which the default
 * `chromium.launch()` already resolves correctly in this environment — but
 * pointing `executablePath` at the concrete preinstalled binary removes any
 * dependency on that env var being set correctly wherever this config next
 * runs, per the binding contract's explicit instruction not to fall back to
 * `playwright install` if it isn't.
 */
function preinstalledChromiumPath(): string | undefined {
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  // The bundled revision directory name (`chromium-XXXX`) is pinned to
  // whatever @playwright/test's package.json declares and changes on a
  // Playwright version bump — found by prefix rather than hardcoded so this
  // doesn't silently stop working the next time that version moves.
  for (const revisionPrefix of ['chromium-']) {
    try {
      const { readdirSync } = require('node:fs') as typeof import('node:fs');
      const match = readdirSync(browsersPath).find((name) => name.startsWith(revisionPrefix));
      if (match) {
        const candidate = join(browsersPath, match, 'chrome-linux', 'chrome');
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // Directory missing/unreadable — fall through to undefined so
      // Playwright's own default resolution gets a chance instead.
    }
  }
  return undefined;
}

export default defineConfig({
  testDir: './e2e',
  // The full owner journey (sign up, 5 wizard steps including a CSV import,
  // email verification, launch, then a storefront check) realistically
  // spans a couple dozen navigations, each paying Next.js dev mode's
  // per-route first-compile cost under this environment's load (several dev
  // servers + Postgres/Redis/Caddy/MinIO sharing one machine) — 90s (the
  // brief's suggested default) was observed to run out mid-suite even with
  // no other failure. 240s is generous headroom, not a tuned happy-path
  // number.
  timeout: 240_000,
  // Next.js dev mode compiles each route on its first hit — the wizard's
  // first visit to /onboarding (right after sign-up) has been observed
  // taking several seconds under this environment's load (several other dev
  // servers + Postgres/Redis/Caddy/MinIO all running at once), so this is
  // generous rather than tuned to the happy path.
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://admin.ventia.localhost',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { executablePath: preinstalledChromiumPath() },
      },
    },
  ],
});
