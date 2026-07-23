# P1a — Storage + Catalog API + CSV Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server side of M2: S3-compatible storage (MinIO dev / R2 prod), admin session guards, categories/products/variants/images CRUD with plan limits + audit, inventory movements, and CSV import with dry-run.

**Architecture:** New NestJS modules `admin-auth` (guards), `storage`, `catalog`, `csv-import` under `services/api/src/`. All tenant data access goes through `tenantDb(session.tenantId)`; audit writes use `platformDb` (AuditLog is RLS-exempt by design). Admin endpoints live under `/v1/admin/*` and derive the tenant from the authenticated session's membership — NOT from Host/x-tenant-domain (that mechanism is for the public storefront).

**Tech Stack:** NestJS 10 · Prisma 6 (`tenantDb`/`platformDb` from P0) · Zod 3 (schemas in `@ventia/core`) · `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` · papaparse · Vitest + Testcontainers (Postgres pgvector:pg16, Redis 7, MinIO).

## Global Constraints (spec §4 + P0 conventions)

- TypeScript `strict: true`; NodeNext in packages (`.js` on relative src imports), CommonJS in `services/api`.
- Money = integer COP cents. Tax rate enum values `"0" | "5" | "19" | "excluido"` (Prisma enum `TaxRate` ZERO/FIVE/NINETEEN/EXCLUIDO).
- Every mutation: Zod-validated, audit-logged, tenant-scoped via `tenantDb`. `staff` role blocked from settings/payments (guards in this plan; settings endpoints arrive in P1b).
- Typed errors: `{ error: 'PLAN_LIMIT_EXCEEDED' | 'VALIDATION_FAILED' | 'FORBIDDEN_ROLE' | 'UNAUTHENTICATED' | ... , details? }`.
- TDD: failing test → RED evidence → implement → GREEN. Conventional commits, English code/comments/commits, Spanish (es-CO) user-facing error messages in CSV row errors.
- Git identity before committing: `git config user.email noreply@anthropic.com && git config user.name Claude`.
- Test suite baseline entering P1a: db 16, api 19, storefront 2, core 2 — all must stay green.

---

## File Structure (end state of P1a)

```
docker/compose.yaml                       # + minio, minio-init services
packages/core/src/env.ts                  # + S3_* vars
packages/core/src/slug.ts                 # slugify + tests
packages/core/src/catalog-schemas.ts      # Zod schemas shared API<->admin UI
services/api/src/admin/                   # session+roles guards, AdminSession decorator
services/api/src/storage/                 # S3 client factory, presign service+controller
services/api/src/catalog/                 # categories, products, variants, images, stock
services/api/src/csv-import/              # parser, dry-run, commit
services/api/test/                        # helpers-minio.ts + one test file per module
packages/db/src/seed.ts                   # unchanged (P1b touches onboarding)
```

---

### Task 1: MinIO in dev compose + S3 env vars

**Files:**
- Modify: `docker/compose.yaml`, `.env.example`
- Modify: `packages/core/src/env.ts`
- Test: `packages/core/test/env.test.ts` (extend)

**Interfaces:**
- Produces: env fields `S3_ENDPOINT` (url, default `http://localhost:9000`), `S3_ACCESS_KEY` (default `ventia`), `S3_SECRET_KEY` (default `ventia-secret`), `S3_BUCKET` (default `ventia`), `S3_PUBLIC_URL` (url, default `http://localhost:9000/ventia`). MinIO reachable on :9000 (API) / :9001 (console) with bucket `ventia` auto-created and anonymous read enabled.

- [ ] **Step 1: Extend the env test (RED)**

Add to `packages/core/test/env.test.ts`:
```ts
it('provides S3 defaults for dev', () => {
  const env = loadEnv({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    AUTH_SECRET: 'secret',
  });
  expect(env.S3_ENDPOINT).toBe('http://localhost:9000');
  expect(env.S3_BUCKET).toBe('ventia');
  expect(env.S3_PUBLIC_URL).toBe('http://localhost:9000/ventia');
});
```
Run: `pnpm --filter @ventia/core test` → FAIL (unknown properties).

- [ ] **Step 2: Implement env fields (GREEN)**

In `packages/core/src/env.ts` add to `envSchema`:
```ts
S3_ENDPOINT: z.string().url().default('http://localhost:9000'),
S3_ACCESS_KEY: z.string().min(1).default('ventia'),
S3_SECRET_KEY: z.string().min(1).default('ventia-secret'),
S3_BUCKET: z.string().min(1).default('ventia'),
S3_PUBLIC_URL: z.string().url().default('http://localhost:9000/ventia'),
```
Run: `pnpm --filter @ventia/core test` → PASS.

- [ ] **Step 3: Add MinIO to compose**

Append to `docker/compose.yaml` services:
```yaml
  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ventia
      MINIO_ROOT_PASSWORD: ventia-secret
    ports: ["9000:9000", "9001:9001"]
    volumes: [miniodata:/data]
  minio-init:
    image: minio/mc:latest
    depends_on: [minio]
    entrypoint: >
      /bin/sh -c "
      until mc alias set local http://minio:9000 ventia ventia-secret; do sleep 1; done;
      mc mb --ignore-existing local/ventia;
      mc anonymous set download local/ventia;
      exit 0"
```
And add `miniodata:` under `volumes:`. Append the five `S3_*` vars with their dev defaults to `.env.example`.

- [ ] **Step 4: Verify**

Run: `docker compose -f docker/compose.yaml up -d && sleep 8 && curl -s -o /dev/null -w '%{http_code}' http://localhost:9000/minio/health/live`
Expected: `200`. `docker compose -f docker/compose.yaml logs minio-init | tail -2` shows bucket created.

- [ ] **Step 5: Commit**

```bash
git add docker .env.example packages/core && git commit -m "feat: add minio dev storage and s3 env config"
```

---

### Task 2: Slug utility + shared catalog Zod schemas

**Files:**
- Create: `packages/core/src/slug.ts`, `packages/core/src/catalog-schemas.ts`
- Modify: `packages/core/src/index.ts` (add `export * from './slug.js'; export * from './catalog-schemas.js';`)
- Test: `packages/core/test/slug.test.ts`, `packages/core/test/catalog-schemas.test.ts`

**Interfaces:**
- Produces:
  - `slugify(input: string): string` — lowercase, NFD-strip diacritics, non-alphanumerics → `-`, collapse/trim dashes, max 60 chars.
  - Zod schemas + inferred types: `categoryInputSchema` (`{ name: string(1..80), slug?: string, position?: number int ≥0 }`), `productInputSchema`, `productUpdateSchema` (= partial), `variantsReplaceSchema`, `imageConfirmSchema`, `presignRequestSchema`, `stockAdjustSchema`. `TAX_RATES = ['0','5','19','excluido'] as const`.

- [ ] **Step 1: Write failing tests**

`packages/core/test/slug.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { slugify } from '../src/slug';

describe('slugify', () => {
  it('lowercases, strips accents, dashes spaces', () => {
    expect(slugify('Camiseta Básica Ñoño')).toBe('camiseta-basica-nono');
  });
  it('collapses symbols and trims dashes', () => {
    expect(slugify('  ¡Jean -- Clásico! 30% ')).toBe('jean-clasico-30');
  });
  it('caps length at 60', () => {
    expect(slugify('x'.repeat(100))).toHaveLength(60);
  });
});
```

`packages/core/test/catalog-schemas.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { productInputSchema, variantsReplaceSchema } from '../src/catalog-schemas';

describe('productInputSchema', () => {
  it('accepts a minimal valid product', () => {
    const p = productInputSchema.parse({ name: 'Camiseta', priceCents: 4590000 });
    expect(p.taxRate).toBe('19'); // default
    expect(p.status).toBe('draft');
  });
  it('rejects non-integer or negative money', () => {
    expect(() => productInputSchema.parse({ name: 'x', priceCents: 10.5 })).toThrow();
    expect(() => productInputSchema.parse({ name: 'x', priceCents: -1 })).toThrow();
  });
  it('rejects more than 3 variant options', () => {
    expect(() =>
      variantsReplaceSchema.parse({
        options: ['Talla', 'Color', 'Material', 'Extra'],
        variants: [],
      }),
    ).toThrow();
  });
});
```
Run: `pnpm --filter @ventia/core test` → FAIL (modules not found).

- [ ] **Step 2: Implement**

`packages/core/src/slug.ts`:
```ts
export function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}
```

`packages/core/src/catalog-schemas.ts`:
```ts
import { z } from 'zod';

export const TAX_RATES = ['0', '5', '19', 'excluido'] as const;
export type TaxRateValue = (typeof TAX_RATES)[number];

const money = z.number().int().min(0);

export const categoryInputSchema = z.object({
  name: z.string().min(1).max(80),
  slug: z.string().min(1).max(60).optional(),
  position: z.number().int().min(0).optional(),
});

export const productInputSchema = z.object({
  name: z.string().min(1).max(160),
  slug: z.string().min(1).max(60).optional(),
  descriptionMd: z.string().max(20_000).default(''),
  priceCents: money,
  compareAtCents: money.optional(),
  costCents: money.optional(),
  sku: z.string().max(64).optional(),
  barcode: z.string().max(64).optional(),
  stock: z.number().int().min(0).default(0),
  trackInventory: z.boolean().default(true),
  taxRate: z.enum(TAX_RATES).default('19'),
  status: z.enum(['draft', 'active', 'archived']).default('draft'),
  categoryIds: z.array(z.string().uuid()).max(20).default([]),
  seo: z.object({ title: z.string().max(70), description: z.string().max(160) }).partial().optional(),
});
export const productUpdateSchema = productInputSchema.partial();

export const variantsReplaceSchema = z.object({
  options: z.array(z.string().min(1).max(30)).min(1).max(3),
  variants: z
    .array(
      z.object({
        option1: z.string().max(60).optional(),
        option2: z.string().max(60).optional(),
        option3: z.string().max(60).optional(),
        priceCents: money.optional(),
        sku: z.string().max(64).optional(),
        stock: z.number().int().min(0).default(0),
      }),
    )
    .max(100),
});

export const presignRequestSchema = z.object({
  filename: z.string().min(1).max(200),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  size: z.number().int().min(1).max(5 * 1024 * 1024),
});

export const imageConfirmSchema = z.object({
  key: z.string().min(1).max(300),
  alt: z.string().max(160).optional(),
  position: z.number().int().min(0).default(0),
});

export const stockAdjustSchema = z.object({
  variantId: z.string().uuid().optional(),
  delta: z.number().int().refine((n) => n !== 0, 'delta must be non-zero'),
  reason: z.enum(['restock', 'manual_adjust', 'correction']),
});

export type ProductInput = z.infer<typeof productInputSchema>;
export type ProductUpdate = z.infer<typeof productUpdateSchema>;
export type CategoryInput = z.infer<typeof categoryInputSchema>;
export type VariantsReplace = z.infer<typeof variantsReplaceSchema>;
export type StockAdjust = z.infer<typeof stockAdjustSchema>;
```

- [ ] **Step 3: GREEN + commit**

Run: `pnpm --filter @ventia/core test` → PASS (all, including P0's 2).
```bash
git add packages/core && git commit -m "feat: add slug util and shared catalog schemas"
```

---

### Task 3: Admin session guards (`/v1/admin/*` foundation)

**Files:**
- Create: `services/api/src/admin/admin-session.guard.ts`, `services/api/src/admin/roles.decorator.ts`, `services/api/src/admin/admin.module.ts`
- Modify: `services/api/src/app.module.ts` (import AdminModule), `services/api/src/main.ts` (export an `auth` instance accessor if needed)
- Test: `services/api/test/admin-guard.test.ts`

**Interfaces:**
- Consumes: `createAuth`, `getSessionContext` (P0 Task 9), `platformDb`.
- Produces:
  - `AdminSessionGuard` (Nest `CanActivate`): reads better-auth cookie from the request via `getSessionContext`; rejects 401 `{ error: 'UNAUTHENTICATED' }` without session, 403 `{ error: 'NO_TENANT' }` if session has no membership; attaches `req.adminSession = { userId, email, tenantId, role }`.
  - `@Roles('owner')` decorator + role check inside the guard (metadata via `Reflector`); wrong role → 403 `{ error: 'FORBIDDEN_ROLE' }`.
  - `AdminSession()` param decorator returning `req.adminSession`.
  - A single shared `auth` instance: refactor `createApp` so the `createAuth(...)` result is created once in a `AuthService`-style provider (`AUTH_INSTANCE` token in AdminModule via `useFactory`) AND reused by the `toNodeHandler` mount — one instance, not two.

- [ ] **Step 1: Write failing tests**

`services/api/test/admin-guard.test.ts` — integration through a real app (pattern: same container setup as `tenant-endpoint.test.ts`: startTestDb + redis container + env before dynamic `createApp` import). Add a temporary probe controller? NO — test against a real endpoint added in this task for testability: `GET /v1/admin/me` (in AdminModule) returning the `adminSession` — it doubles as a useful endpoint for the UI.

Tests:
```ts
describe('GET /v1/admin/me', () => {
  it('401 without a session', async () => {
    const res = await request(app.getHttpServer()).get('/v1/admin/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('403 NO_TENANT with session but no membership', async () => {
    const cookie = await signUpAndGetCookie('nomember@demo.co'); // helper below
    const res = await request(app.getHttpServer()).get('/v1/admin/me').set('cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('NO_TENANT');
  });

  it('returns the admin session with membership', async () => {
    const { cookie, tenantId, userId } = await signUpWithTenant('owner1@demo.co', 'owner');
    const res = await request(app.getHttpServer()).get('/v1/admin/me').set('cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId, tenantId, role: 'owner', email: 'owner1@demo.co' });
  });
});
```
Create `services/api/test/admin-helpers.ts` with `signUpAndGetCookie(email)` (better-auth signUpEmail + signInEmail `returnHeaders: true`, return the set-cookie string) and `signUpWithTenant(email, role)` (signup + `platformDb.tenant.create` + `platformDb.membership.create`, returns `{ cookie, tenantId, userId }`). Use a fresh PrismaClient bound to the test container URL (import PrismaClient from '@ventia/db').

Run: `pnpm --filter @ventia/api test -- admin-guard` → FAIL.

- [ ] **Step 2: Implement guard, decorators, module, `/v1/admin/me`**

`roles.decorator.ts`:
```ts
import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { SessionContext } from '../auth/session-context';

export const ROLES_KEY = 'admin_roles';
export const Roles = (...roles: Array<'owner' | 'staff'>) => SetMetadata(ROLES_KEY, roles);

export const AdminSession = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest().adminSession as SessionContext;
});
```

`admin-session.guard.ts`:
```ts
import { CanActivate, ExecutionContext, HttpException, Injectable, Inject } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { platformDb } from '@ventia/db';
import { getSessionContext } from '../auth/session-context';
import { ROLES_KEY } from './roles.decorator';
import { AUTH_INSTANCE } from './admin.module';

@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH_INSTANCE) private readonly auth: unknown,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const headers = new Headers();
    if (req.headers.cookie) headers.set('cookie', req.headers.cookie);
    const session = await getSessionContext(this.auth as never, platformDb, headers);
    if (!session) throw new HttpException({ error: 'UNAUTHENTICATED' }, 401);
    if (!session.tenantId || !session.role || session.role === 'platform_admin') {
      throw new HttpException({ error: 'NO_TENANT' }, 403);
    }
    const required = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (required && !required.includes(session.role)) {
      throw new HttpException({ error: 'FORBIDDEN_ROLE' }, 403);
    }
    req.adminSession = session;
    return true;
  }
}
```

`admin.module.ts` — export `AUTH_INSTANCE` token + provider (factory calling `createAuth(platformDb, { secret: process.env.AUTH_SECRET ?? 'dev-secret-change-me', baseURL: process.env.API_URL ?? 'http://api.ventia.localhost' })`), `AdminMeController` (`@Controller('v1/admin/me')`, `@UseGuards(AdminSessionGuard)`, GET returns `session`), exports the provider + guard. Refactor `main.ts` to pull the same `AUTH_INSTANCE` from the Nest container for `toNodeHandler` (`app.get(AUTH_INSTANCE)`) instead of calling `createAuth` separately — verify the existing auth tests still pass.

- [ ] **Step 3: GREEN + full suite + commit**

Run: `pnpm --filter @ventia/api test` → all pass (19 + 3 new).
```bash
git add services/api && git commit -m "feat: add admin session and role guards with /v1/admin/me"
```

---

### Task 4: Storage module — presigned uploads

**Files:**
- Create: `services/api/src/storage/storage.service.ts`, `services/api/src/storage/storage.module.ts`
- Test: `services/api/test/storage.test.ts`, `services/api/test/helpers-minio.ts`
- Modify: `services/api/package.json` (add `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`)

**Interfaces:**
- Consumes: env S3_* (Task 1), `presignRequestSchema` (Task 2).
- Produces:
  - `StorageService.presignProductImage(tenantId: string, productId: string, req: { filename; contentType; size }): Promise<{ uploadUrl: string; key: string; publicUrl: string }>` — key = `tenants/{tenantId}/products/{productId}/{uuid}.{ext}` (ext from contentType, NOT from filename); presigned PUT (5 min expiry, content-type + content-length constrained).
  - `StorageService.publicUrlFor(key: string): string` = `${S3_PUBLIC_URL}/${key}`.
  - `helpers-minio.ts`: `startMinio(): Promise<{ endpoint, stop }>` — GenericContainer `minio/minio` with `server /data`, exposed 9000, env root user/password, wait for log `/API:/` or health check.

- [ ] **Step 1: Write failing tests**

`services/api/test/storage.test.ts`:
```ts
// startMinio + build StorageService directly with a config object (no Nest app needed):
// new StorageService({ endpoint, accessKey: 'ventia', secretKey: 'ventia-secret', bucket: 'ventia', publicUrl: `${endpoint}/ventia` })
// beforeAll: create the bucket via S3Client CreateBucketCommand.

it('presigns a PUT that actually uploads to minio', async () => {
  const { uploadUrl, key, publicUrl } = await storage.presignProductImage(T1, PRODUCT_ID, {
    filename: 'foto.JPG', contentType: 'image/jpeg', size: 1234,
  });
  expect(key).toMatch(new RegExp(`^tenants/${T1}/products/${PRODUCT_ID}/[0-9a-f-]{36}\\.jpg$`));
  const body = Buffer.alloc(1234, 1);
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body });
  expect(put.status).toBe(200);
  expect(publicUrl).toBe(`${endpoint}/ventia/${key}`);
});

it('rejects a disallowed content type at the schema layer', () => {
  expect(() => presignRequestSchema.parse({ filename: 'x.gif', contentType: 'image/gif', size: 10 })).toThrow();
});
```
Run → FAIL (module not found).

- [ ] **Step 2: Implement**

`storage.service.ts` — constructor takes `{ endpoint, accessKey, secretKey, bucket, publicUrl }`; builds `S3Client` with `forcePathStyle: true` (required for MinIO), `region: 'auto'`. `presignProductImage` validates via `presignRequestSchema`, maps contentType→ext (`image/jpeg`→`jpg`, `image/png`→`png`, `image/webp`→`webp`), generates `crypto.randomUUID()`, uses `getSignedUrl(client, new PutObjectCommand({ Bucket, Key, ContentType, ContentLength }), { expiresIn: 300 })`. `storage.module.ts` provides it from `process.env` S3_* values (with the Task-1 defaults).

- [ ] **Step 3: GREEN + commit**

Run: `pnpm --filter @ventia/api test -- storage` → PASS; full suite green.
```bash
git add services/api && git commit -m "feat: add s3 storage service with presigned product image uploads"
```

---

### Task 5: Categories CRUD

**Files:**
- Create: `services/api/src/catalog/categories.controller.ts`, `services/api/src/catalog/catalog.module.ts`, `services/api/src/catalog/audit.ts`
- Test: `services/api/test/categories.test.ts`

**Interfaces:**
- Consumes: `AdminSessionGuard`/`AdminSession` (Task 3), `tenantDb`, `categoryInputSchema`, `slugify`.
- Produces: under `/v1/admin/categories` (guard applied at controller level, both roles allowed):
  - `GET /` → `Category[]` ordered by `position, name`.
  - `POST /` body `CategoryInput` → 201 category; slug = provided or `slugify(name)`; duplicate slug in tenant → 409 `{ error: 'SLUG_TAKEN' }`.
  - `PATCH /:id` partial input → updated; `DELETE /:id` → 204, products keep existing (join rows cascade only in `ProductCategory`).
  - `audit.ts`: `writeAudit(session, action, entity, entityId, data?)` → `platformDb.auditLog.create({ data: { tenantId: session.tenantId, actorUserId: session.userId, action, entity, entityId, data } })`. Every mutation in this and later tasks calls it.

- [ ] **Step 1: Failing tests** — integration file `categories.test.ts` using `signUpWithTenant` (Task 3 helper): create → list → duplicate slug 409 → patch → delete → audit rows exist (`platformDb.auditLog.count({ where: { tenantId } })` ≥ 3). Also: a category created by tenant A is invisible to tenant B's session (isolation ride-along, one test).
- [ ] **Step 2: Implement** controller with Zod parse (wrap `schema.parse` in a helper `parseOr400` that throws `HttpException({ error: 'VALIDATION_FAILED', details: zodError.flatten() }, 400)`), `tenantDb(session.tenantId).category.*`, Prisma `P2002` catch → 409 SLUG_TAKEN. Register CatalogModule in AppModule.
- [ ] **Step 3: GREEN + full suite + commit** — `git commit -m "feat: add categories crud with audit logging"`

---

### Task 6: Products CRUD + plan limits

**Files:**
- Create: `services/api/src/catalog/products.controller.ts`, `services/api/src/catalog/products.service.ts`, `services/api/src/catalog/plan-limits.ts`
- Test: `services/api/test/products.test.ts`

**Interfaces:**
- Consumes: Tasks 2/3/5 artifacts.
- Produces under `/v1/admin/products`:
  - `GET /?search=&status=&page=&pageSize=` → `{ items, total, page, pageSize }` (pageSize ≤ 100 default 20; search = case-insensitive contains on name/sku).
  - `POST /` `ProductInput` → 201 (slug auto/dedup: on collision append `-2`, `-3`… up to `-20` then 409); connects `categoryIds` via nested `categories: { create: ids.map(...) }` — remember `ProductCategory` needs `tenantId` too.
  - `GET /:id` (includes variants, images, categoryIds), `PATCH /:id`, `DELETE /:id` → archive (status=archived), NOT hard delete.
  - `plan-limits.ts`: `assertProductLimit(session)`: counts non-archived products, compares to `tenant_limits.productsMax` (fetch via `tenantDb(...).tenantLimits.findUnique({ where: { tenantId } })` — note: RLS-visible); at/over limit → 402 `{ error: 'PLAN_LIMIT_EXCEEDED', details: { limit } }`. Called by POST and by CSV commit (Task 8).
- Tests must cover: create/list/filter/paginate, slug dedup (`camiseta`, `camiseta-2`), limit enforcement (set productsMax=2 in fixture, third create → 402), archive keeps row (`GET /:id` still 200, list with status=active excludes it), staff role CAN create products (both roles allowed on catalog), audit rows written, cross-tenant invisibility.

Steps: failing tests → implement → GREEN full suite → commit `feat: add products crud with plan limit enforcement`.

---

### Task 7: Variants, images, stock adjustments

**Files:**
- Create: `services/api/src/catalog/variants.controller.ts`, `services/api/src/catalog/images.controller.ts`, `services/api/src/catalog/stock.controller.ts`
- Test: `services/api/test/variants-images-stock.test.ts`

**Interfaces:**
- Consumes: Tasks 2/3/4/6.
- Produces:
  - `PUT /v1/admin/products/:id/variants` body `VariantsReplace` → replaces the variant set (delete existing + create new; sequential `tenantDb` ops — the extension has no multi-op transaction — RLS covers each). **Binding decision:** the variant OPTION LABELS (e.g. `["Talla", "Color"]`) need a home the §8 schema lacks; add a Prisma migration `product_options` adding `options String[] @default([])` to `Product` (max 3 labels). Variant rows carry the option VALUES in `option1..3`. Minimal schema addition for M2's variant editor; document it in the task report.
  - `POST /v1/admin/products/:id/images/presign` body `presignRequestSchema` (+ reject if product already has 8 images → 409 `{ error: 'IMAGE_LIMIT' }`) → `{ uploadUrl, key, publicUrl }` via StorageService.
  - `POST /v1/admin/products/:id/images` body `imageConfirmSchema` → creates `ProductImage` row with `url = publicUrlFor(key)`; `DELETE /v1/admin/products/:id/images/:imageId` → 204.
  - `POST /v1/admin/products/:id/stock` body `StockAdjust` → adjusts `stock` on product or variant (`variantId`), floor at 0 (going below → 422 `{ error: 'STOCK_BELOW_ZERO' }`), writes `InventoryMovement { delta, reason, actor: session.userId }`, audit row.
- Tests: variant replace (2 options × values, price override), image presign+confirm flow against MinIO (reuse `startMinio`), 9th image rejected, stock adjust up/down + movement rows + below-zero rejection.

Steps: failing tests → migration (`prisma migrate dev --name product_options`) → implement → GREEN full suite (db suite must also stay green — migration applies in its containers) → commit `feat: add variants, image uploads, and stock adjustments`.

---

### Task 8: CSV import (dry-run + commit)

**Files:**
- Create: `services/api/src/csv-import/csv-import.controller.ts`, `services/api/src/csv-import/csv-parser.ts`, `services/api/src/csv-import/csv-import.service.ts`
- Create: `services/api/test/fixtures/products-valid.csv`, `products-errors.csv`, `products-500.csv` (generate the 500-row file with a small script inside the test, not committed as 500 literal lines — write it to a temp path in beforeAll)
- Test: `services/api/test/csv-import.test.ts`
- Modify: `services/api/package.json` (add `papaparse`, `@types/papaparse`)

**Interfaces:**
- Consumes: Tasks 2/3/6 (products service create/update paths, plan limits).
- Produces:
  - CSV template columns (documented in the controller's `GET /v1/admin/import/template` which returns the header line + one example row as `text/csv`): `name,slug,description,price_cents,compare_at_cents,sku,barcode,stock,track_inventory,tax_rate,status,categories,image_urls` — `categories` = `|`-separated names (created if missing), `image_urls` = `|`-separated http(s) URLs stored directly as `ProductImage.url`.
  - `csv-parser.ts`: `parseProductsCsv(text: string): { rows: ParsedRow[]; errors: RowError[] }` — pure function; `RowError = { row: number; column: string; message: string }` (messages in Spanish, e.g. `"price_cents debe ser un entero en centavos"`); validation via a row Zod schema derived from `productInputSchema` (coercions: `stock`/`price_cents` via `z.coerce.number().int()`, `track_inventory` from `"true"/"false"/""`, `tax_rate` from TAX_RATES, `sku` REQUIRED here — upsert key).
  - `POST /v1/admin/import/dry-run` (body: `{ csv: string }`, max 2 MB) → `{ valid: n, invalid: n, creates: n, updates: n, errors: RowError[] (first 100), limitExceeded?: boolean }` — `updates` = rows whose SKU already exists in the tenant; `limitExceeded` computed against `productsMax`.
  - `POST /v1/admin/import/commit` (same body) → re-parses, re-validates; ANY row error → 422 with the error list (no partial import); enforces plan limit counting only creates; runs inside a single transaction? `tenantDb`'s extension wraps ops individually — run the loop through `platformDb.$transaction(async tx => ...)` with manual `SET LOCAL ROLE ventia_app` + `set_config` (mirror the extension's pattern; this is the documented system-context escape and MUST set the GUC — write a comment saying why). Upsert by `(tenantId, sku)` — needs a lookup map first (`findMany where sku in [...]`). Creates image rows from `image_urls`, connects/creates categories. Returns `{ created, updated }`.
  - AC test: the 500-row generated CSV commits in < 60 s (assert elapsed).
- Tests: valid file dry-run counts, errors file per-row Spanish errors (bad tax_rate, negative price, missing sku), commit idempotence (run commit twice with same file → second run all `updates`, product count unchanged), plan limit blocks commit (products_max fixture), 500-row perf, audit row (`action: 'csv_import'`, data `{ created, updated }`).

Steps: failing tests (parser unit tests first, then endpoint integration) → implement → GREEN full suite → commit `feat: add csv product import with dry-run and transactional commit`.

---

### Task 9: P1a wrap-up — verification + docs

**Files:**
- Modify: `README.md` (Development section: minio in stack list, S3 env vars table, CSV template note)
- Modify: `.github/workflows/ci.yml` — no change expected (tests self-contained via Testcontainers); verify only.

**Steps:**
- [ ] Run `pnpm turbo run lint typecheck build` and `pnpm turbo run test` — everything green (expect api suite to have grown by ~25 tests).
- [ ] Update README (10 lines max), commit `docs: document minio storage and csv import in quickstart`.
- [ ] Verify with the dev stack: `docker compose up -d`, presign + upload one image via curl against a seeded tenant (manual smoke, capture in task report).

---

## Self-Review Notes

- **Spec coverage:** M2 fields/AC map to Tasks 2/6/7/8 (CSV < 60 s AC pinned by test; category delete AC pinned in Task 5; archived-products-404 is a storefront concern → P2, noted). M8's "staff cannot reach settings" — settings endpoints don't exist until P1b; the guard + `@Roles` mechanism lands here (Task 3) and P1b's settings endpoints must use `@Roles('owner')` (recorded as a P1b requirement).
- **Known judgment calls:** `Product.options String[]` migration (Task 7) is a small, documented schema addition beyond spec §8; CSV commit uses the manual GUC transaction escape with a mandatory explanatory comment; CSV images accepted as external URLs (spec M2 says image columns accept URLs).
- **Type consistency check:** `SessionContext` reused from P0 for `adminSession`; `PLAN_LIMIT_EXCEEDED` 402 shape shared between products POST and CSV commit; `presignRequestSchema` used by both storage service and images controller.
- The intentional `VariantsReplaace` decoy in Task 2 must NOT appear in committed code (implementer instruction embedded at the site).
