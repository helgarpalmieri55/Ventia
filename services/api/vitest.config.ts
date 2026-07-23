import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', hookTimeout: 120_000, testTimeout: 60_000 },
});
