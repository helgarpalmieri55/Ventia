import { defineConfig } from 'vitest/config';

// `e2e/*.spec.ts` uses @playwright/test's own `test`/`expect` (a real
// browser, the dev servers, the API's mail log) — it must never be picked up
// by vitest's default `**/*.spec.ts` include glob, which would try to run it
// as a unit test and fail immediately on the unfamiliar test runner globals.
// `pnpm turbo run test` (this project's `test` script) stays e2e-free by
// construction; the e2e suite is a separate, locally-run `pnpm --filter
// @ventia/admin exec playwright test` (see scripts/e2e.sh).
export default defineConfig({ test: { environment: 'node', exclude: ['node_modules/**', 'e2e/**'] } });
