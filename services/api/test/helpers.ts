import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Copied from packages/db/test/helpers.ts (see task-8 brief: duplication of this
// 15-line test helper is acceptable to avoid cross-package export-map/vitest friction).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function startTestDb(): Promise<{ url: string; container: StartedPostgreSqlContainer; stop: () => Promise<void> }> {
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  const url = container.getConnectionUri();
  execSync('npx prisma migrate deploy', {
    cwd: path.resolve(__dirname, '../../../packages/db'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
  return { url, container, stop: () => container.stop().then(() => undefined) };
}
