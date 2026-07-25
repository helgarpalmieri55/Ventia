# P2a — Public Storefront Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shopper can browse a live tenant's storefront (home, categories, search, product detail, policy pages) themed per the tenant's saved branding, with SEO — the read-only foundation P2b's cart/checkout builds on.

**Architecture:** New public, unauthenticated NestJS module `services/api/src/storefront/` reusing the P0 `TenantMiddleware`/`x-tenant-domain` resolution; a `PublicTenantGuard` attaches the resolved tenant and enforces 404 (unresolved)/503 (suspended). `apps/storefront` fetches from it directly (no session, no `/api` proxy needed). Full-text/trigram search uses the manual RLS-scoped transaction escape already established in `products.service.ts` (raw SQL under `SET LOCAL ROLE ventia_app` + the tenant GUC) since the `tenantDb` extension deliberately blocks raw queries.

**Tech Stack:** NestJS 10 (existing) · Postgres `pg_trgm` + built-in `spanish` FTS config (no new extensions — `pg_trgm` already installed by the P0 RLS migration) · Next.js 15 App Router (ISR + on-demand tag revalidation) · `packages/ui` primitives (existing) · `next/font` for the 5 fixed pairs.

## Global Constraints

- TypeScript strict; TDD with genuine RED; conventional commits; English code/comments, es-CO storefront copy.
- Every storefront read is tenant-scoped: either `tenantDb(tenantId)` for ordinary Prisma queries, or the manual `SET LOCAL ROLE ventia_app` + `set_config('app.tenant_id', ...)` transaction escape for raw SQL — never `platformDb` unscoped.
- No AI chat widget (deferred whole to P4). No cart/checkout interactivity (P2b) — PDP's buy affordance renders but is inert.
- Typed errors: `{ error: 'TENANT_NOT_FOUND' }` (404), `{ error: 'TENANT_SUSPENDED' }` (503).
- Git identity before commits: `git config user.email noreply@anthropic.com && git config user.name Claude`.
- Baseline entering P2a: api 138, admin 93, core 17, db 16, storefront 2 — stays green throughout.
- Prisma raw-SQL fragment composition (`Prisma.sql`/`Prisma.empty` nesting) must be verified against the installed Prisma 6.x version at implementation time, not assumed from memory — the exact placeholder/fragment behavior has changed across minor versions.

---

## File Structure (end state of P2a)

```
services/api/src/storefront/
  public-tenant.guard.ts       # 404/503 guard, reused across all controllers below
  storefront-tenant.decorator.ts
  storefront.module.ts
  categories.controller.ts
  content.controller.ts
  products.controller.ts
  products.service.ts          # FTS/trigram search + detail + related
packages/core/src/env.ts        # + REVALIDATE_SECRET, STOREFRONT_INTERNAL_URL
apps/storefront/
  app/
    layout.tsx                 # + theme CSS vars, font pairs
    page.tsx                   # home (rewritten)
    categorias/[slug]/page.tsx
    productos/[slug]/page.tsx
    buscar/page.tsx
    envios/page.tsx
    cambios-y-devoluciones/page.tsx
    privacidad/page.tsx
    contacto/page.tsx
    not-found.tsx
    sitemap.ts
    robots.ts
    api/revalidate/route.ts
  lib/
    storefront-api.ts           # fetch client for the new module
    theme.ts                    # CSS-variable builder from ResolvedTheme
    format.ts                   # formatCOP (local copy, 8 lines — not worth sharing)
    policy-defaults.ts           # es-CO fallback copy per content type
  components/
    product-card.tsx
    product-grid.tsx
    price.tsx
```

---

### Task 1: Public tenant guard + categories + content endpoints

**Files:**
- Create: `services/api/src/storefront/public-tenant.guard.ts`, `storefront-tenant.decorator.ts`, `storefront.module.ts`, `categories.controller.ts`, `content.controller.ts`
- Modify: `services/api/src/app.module.ts`
- Test: `services/api/test/storefront-categories.test.ts`, `services/api/test/storefront-content.test.ts`

**Interfaces:**
- Produces: `PublicTenantGuard` (CanActivate) — reads `req.tenant` (set by the existing `TenantMiddleware`, unconditionally applied to `'*'` in `AppModule`); throws `NotFoundException({ error: 'TENANT_NOT_FOUND' })` if null, `HttpException({ error: 'TENANT_SUSPENDED' }, 503)` if `status === 'suspended'`; on success attaches `req.storefrontTenantId = req.tenant.tenantId`.
- `@StorefrontTenantId()` param decorator returning `req.storefrontTenantId as string` (guard-guaranteed non-null, same narrowing pattern as `AdminSession()`).
- `GET /v1/storefront/categories` → `Array<{ id: string; name: string; slug: string; productCount: number }>`, active-product counts only, ordered `position asc, name asc`.
- `GET /v1/storefront/content/:type` where `type` is one of `faq|policy_shipping|policy_returns|policy_privacy|about` (else 400) → `{ title: string; bodyMd: string }` or 404 `{ error: 'CONTENT_NOT_FOUND' }` (the storefront page renders its own es-CO default on 404 — this endpoint does not).

- [ ] **Step 1: Write failing tests**

`services/api/test/storefront-categories.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { startTestDb } from './helpers';
import { PrismaClient } from '@ventia/db';

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClient;
let app: INestApplication;
let liveTenantId: string;

beforeAll(async () => {
  db = await startTestDb();
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = 'redis://localhost:6379'; // reuse the existing dev redis; storefront tests don't need isolation from admin tests' redis keys since domains differ
  prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
  const tenant = await prisma.tenant.create({ data: { slug: 'sf-cat', name: 'SF Cat', status: 'live' } });
  liveTenantId = tenant.id;
  await prisma.tenantDomain.create({ data: { tenantId: tenant.id, domain: 'sf-cat.ventia.localhost', isPrimary: true } });
  const suspended = await prisma.tenant.create({ data: { slug: 'sf-susp', name: 'SF Susp', status: 'suspended' } });
  await prisma.tenantDomain.create({ data: { tenantId: suspended.id, domain: 'sf-susp.ventia.localhost', isPrimary: true } });

  const cat = await prisma.category.create({ data: { tenantId: liveTenantId, name: 'Ropa', slug: 'ropa', position: 0 } });
  const p1 = await prisma.product.create({ data: { tenantId: liveTenantId, name: 'Camiseta', slug: 'camiseta', priceCents: 45900, status: 'active' } });
  await prisma.product.create({ data: { tenantId: liveTenantId, name: 'Borrador', slug: 'borrador', priceCents: 1000, status: 'draft' } });
  await prisma.productCategory.create({ data: { tenantId: liveTenantId, productId: p1.id, categoryId: cat.id } });
  await prisma.category.create({ data: { tenantId: liveTenantId, name: 'Vacía', slug: 'vacia', position: 1 } });

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await db.stop();
});

describe('GET /v1/storefront/categories', () => {
  it('lists categories with active-product counts, ordered', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/categories')
      .set('x-tenant-domain', 'sf-cat.ventia.localhost');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: expect.any(String), name: 'Ropa', slug: 'ropa', productCount: 1 },
      { id: expect.any(String), name: 'Vacía', slug: 'vacia', productCount: 0 },
    ]);
  });

  it('404s for an unresolved tenant', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/categories')
      .set('x-tenant-domain', 'nope.ventia.localhost');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('TENANT_NOT_FOUND');
  });

  it('503s for a suspended tenant', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/categories')
      .set('x-tenant-domain', 'sf-susp.ventia.localhost');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('TENANT_SUSPENDED');
  });
});
```

`services/api/test/storefront-content.test.ts` (reuse the same beforeAll pattern in a second file; add one `TenantContent` row for the live tenant):
```ts
describe('GET /v1/storefront/content/:type', () => {
  it('returns saved content', async () => {
    await prisma.tenantContent.create({
      data: { tenantId: liveTenantId, type: 'policy_shipping', title: 'Envíos', bodyMd: 'Entregamos en 3 días.' },
    });
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/content/policy_shipping')
      .set('x-tenant-domain', 'sf-cat.ventia.localhost');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ title: 'Envíos', bodyMd: 'Entregamos en 3 días.' });
  });

  it('404s CONTENT_NOT_FOUND when nothing saved', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/content/about')
      .set('x-tenant-domain', 'sf-cat.ventia.localhost');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('CONTENT_NOT_FOUND');
  });

  it('400s an invalid type', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/content/bogus')
      .set('x-tenant-domain', 'sf-cat.ventia.localhost');
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `pnpm --filter @ventia/api test -- storefront-categories storefront-content`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`services/api/src/storefront/public-tenant.guard.ts`:
```ts
import { CanActivate, ExecutionContext, HttpException, Injectable, NotFoundException } from '@nestjs/common';

@Injectable()
export class PublicTenantGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    if (!req.tenant) throw new NotFoundException({ error: 'TENANT_NOT_FOUND' });
    if (req.tenant.status === 'suspended') {
      throw new HttpException({ error: 'TENANT_SUSPENDED' }, 503);
    }
    req.storefrontTenantId = req.tenant.tenantId;
    return true;
  }
}
```

`services/api/src/storefront/storefront-tenant.decorator.ts`:
```ts
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

export const StorefrontTenantId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  return ctx.switchToHttp().getRequest().storefrontTenantId as string;
});
```

`services/api/src/storefront/categories.controller.ts`:
```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { tenantDb } from '@ventia/db';
import { PublicTenantGuard } from './public-tenant.guard';
import { StorefrontTenantId } from './storefront-tenant.decorator';

@Controller('v1/storefront/categories')
@UseGuards(PublicTenantGuard)
export class StorefrontCategoriesController {
  @Get()
  async list(@StorefrontTenantId() tenantId: string) {
    const categories = await tenantDb(tenantId).category.findMany({
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
      include: { products: { where: { product: { status: 'active' } } } },
    });
    return categories.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      productCount: c.products.length,
    }));
  }
}
```
Note: `ProductCategory` rows already carry `tenantId`; the nested `where: { product: { status: 'active' } }` filters the join by the related product's status — verify this Prisma relation-filter syntax against the installed client (it's the standard `include.where` on a to-many relation, but confirm the generated types accept it for `ProductCategory` specifically).

`services/api/src/storefront/content.controller.ts`:
```ts
import { Controller, Get, HttpException, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { tenantDb } from '@ventia/db';
import { PublicTenantGuard } from './public-tenant.guard';
import { StorefrontTenantId } from './storefront-tenant.decorator';

const VALID_TYPES = ['faq', 'policy_shipping', 'policy_returns', 'policy_privacy', 'about'] as const;
type ContentType = (typeof VALID_TYPES)[number];

@Controller('v1/storefront/content')
@UseGuards(PublicTenantGuard)
export class StorefrontContentController {
  @Get(':type')
  async get(@StorefrontTenantId() tenantId: string, @Param('type') type: string) {
    if (!VALID_TYPES.includes(type as ContentType)) {
      throw new HttpException({ error: 'VALIDATION_FAILED', details: { type: 'tipo inválido' } }, 400);
    }
    const content = await tenantDb(tenantId).tenantContent.findUnique({
      where: { tenantId_type: { tenantId, type: type as ContentType } },
    });
    if (!content) throw new NotFoundException({ error: 'CONTENT_NOT_FOUND' });
    return { title: content.title, bodyMd: content.bodyMd };
  }
}
```

`services/api/src/storefront/storefront.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { StorefrontCategoriesController } from './categories.controller';
import { StorefrontContentController } from './content.controller';

@Module({
  controllers: [StorefrontCategoriesController, StorefrontContentController],
})
export class StorefrontModule {}
```

Modify `services/api/src/app.module.ts`: import and add `StorefrontModule` to the `imports` array (alongside `CatalogModule`/`AdminModule`). The existing `TenantMiddleware` is already applied to `'*'` in `configure()` — no change needed there; it already populates `req.tenant` for every request including these new public routes.

- [ ] **Step 4: Run to verify GREEN**

Run: `pnpm --filter @ventia/api test -- storefront-categories storefront-content`
Expected: PASS (6 tests). Then full suite: `pnpm --filter @ventia/api test` (138 + 6).

- [ ] **Step 5: Commit**

```bash
git add services/api && git commit -m "feat: add public storefront categories and content endpoints"
```

---

### Task 2: Product search/list endpoint (FTS + trigram)

**Files:**
- Create: `services/api/src/storefront/products.service.ts`, `products.controller.ts`
- Modify: `services/api/src/storefront/storefront.module.ts`
- Test: `services/api/test/storefront-products.test.ts`

**Interfaces:**
- Produces: `StorefrontProductsService.list(tenantId, params): Promise<StorefrontProductListResult>` where `params = { search?: string; categorySlug?: string; priceMax?: number; sort?: 'relevance'|'price'|'newest'; page?: number; pageSize?: number }`; `StorefrontProductListResult = { items: StorefrontProductSummary[]; total: number; page: number; pageSize: number }`; `StorefrontProductSummary = { id: string; name: string; slug: string; priceCents: number; compareAtCents: number | null; thumbnailUrl: string | null; inStock: boolean }`.
- `GET /v1/storefront/products?search=&category=&priceMax=&sort=&page=&pageSize=` → the same shape, JSON-serialized (`total`/`page`/`pageSize` as numbers — `bigint` from the raw `count(*) OVER()` must be converted, not left as a `bigint` which `JSON.stringify` cannot serialize).

- [ ] **Step 1: Write failing tests**

`services/api/test/storefront-products.test.ts` (same container/app setup as Task 1's `storefront-categories.test.ts` — copy the `beforeAll`/`afterAll` block):
```ts
beforeAll(async () => {
  // ...same container + tenant setup as storefront-categories.test.ts, plus:
  await prisma.product.create({
    data: { tenantId: liveTenantId, name: 'Camiseta Básica', slug: 'camiseta-basica', priceCents: 45900, status: 'active', stock: 5 },
  });
  await prisma.product.create({
    data: { tenantId: liveTenantId, name: 'Pantalón Clásico', slug: 'pantalon-clasico', priceCents: 129900, status: 'active', stock: 0, trackInventory: true },
  });
  await prisma.product.create({
    data: { tenantId: liveTenantId, name: 'Borrador', slug: 'borrador', priceCents: 1000, status: 'draft' },
  });
});

describe('GET /v1/storefront/products', () => {
  it('lists only active products with pagination shape', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products')
      .set('x-tenant-domain', 'sf-cat.ventia.localhost');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items.map((i: { slug: string }) => i.slug).sort()).toEqual(['camiseta-basica', 'pantalon-clasico']);
  });

  it('marks an out-of-stock tracked product as not in stock', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products')
      .set('x-tenant-domain', 'sf-cat.ventia.localhost');
    const pantalon = res.body.items.find((i: { slug: string }) => i.slug === 'pantalon-clasico');
    expect(pantalon.inStock).toBe(false);
  });

  it('full-text search matches by name', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products?search=camiseta')
      .set('x-tenant-domain', 'sf-cat.ventia.localhost');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].slug).toBe('camiseta-basica');
  });

  it('trigram search tolerates a typo', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products?search=camista') // missing an 'e'
      .set('x-tenant-domain', 'sf-cat.ventia.localhost');
    expect(res.body.items.map((i: { slug: string }) => i.slug)).toContain('camiseta-basica');
  });

  it('filters by priceMax', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products?priceMax=100000')
      .set('x-tenant-domain', 'sf-cat.ventia.localhost');
    expect(res.body.items.map((i: { slug: string }) => i.slug)).toEqual(['camiseta-basica']);
  });

  it('another tenant never sees these products (isolation)', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products')
      .set('x-tenant-domain', 'sf-susp.ventia.localhost'); // different tenant id; use a third live one if suspended 503s before reaching the query — add a second live tenant fixture instead
    // adjust: create a third tenant 'sf-other' (status live, no products) in beforeAll and assert res.body.total === 0 against it here
  });
});
```
(The isolation test needs a second **live** empty tenant, not the suspended fixture — add `sf-other.ventia.localhost` in `beforeAll` and target it here; the suspended one is already covered by Task 1's guard tests.)

- [ ] **Step 2: Run to verify RED**

Run: `pnpm --filter @ventia/api test -- storefront-products`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`services/api/src/storefront/products.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { Prisma, platformDb } from '@ventia/db';

export interface StorefrontProductSummary {
  id: string;
  name: string;
  slug: string;
  priceCents: number;
  compareAtCents: number | null;
  thumbnailUrl: string | null;
  inStock: boolean;
}

export interface StorefrontProductListResult {
  items: StorefrontProductSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface StorefrontProductListParams {
  search?: string;
  categorySlug?: string;
  priceMax?: number;
  sort?: 'relevance' | 'price' | 'newest';
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 60;

interface RawRow {
  id: string;
  name: string;
  slug: string;
  priceCents: number;
  compareAtCents: number | null;
  stock: number;
  trackInventory: boolean;
  thumbnailUrl: string | null;
  total: bigint;
}

@Injectable()
export class StorefrontProductsService {
  async list(tenantId: string, params: StorefrontProductListParams): Promise<StorefrontProductListResult> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize ?? DEFAULT_PAGE_SIZE));
    const offset = (page - 1) * pageSize;
    const search = params.search?.trim() || undefined;

    const categoryFilter = params.categorySlug
      ? Prisma.sql`AND EXISTS (
          SELECT 1 FROM "ProductCategory" pc
          JOIN "Category" c ON c.id = pc."categoryId"
          WHERE pc."productId" = p.id AND c.slug = ${params.categorySlug}
        )`
      : Prisma.empty;
    const priceFilter =
      params.priceMax != null ? Prisma.sql`AND p."priceCents" <= ${params.priceMax}` : Prisma.empty;
    const searchFilter = search
      ? Prisma.sql`AND (
          to_tsvector('spanish', p.name || ' ' || p."descriptionMd") @@ plainto_tsquery('spanish', ${search})
          OR similarity(p.name, ${search}) > 0.25
        )`
      : Prisma.empty;
    const orderBy =
      search && (!params.sort || params.sort === 'relevance')
        ? Prisma.sql`ORDER BY ts_rank(to_tsvector('spanish', p.name || ' ' || p."descriptionMd"), plainto_tsquery('spanish', ${search})) DESC, similarity(p.name, ${search}) DESC`
        : params.sort === 'price'
          ? Prisma.sql`ORDER BY p."priceCents" ASC`
          : Prisma.sql`ORDER BY p."createdAt" DESC`;

    return platformDb.$transaction(async (tx) => {
      // Manual tenant-scoped transaction: full-text/trigram search needs raw
      // SQL, which the tenantDb extension deliberately blocks (see
      // packages/db/src/tenant-client.ts). RLS remains the enforcement layer
      // for this statement, same escape pattern as ProductsService.update.
      await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

      const rows = await tx.$queryRaw<RawRow[]>(Prisma.sql`
        SELECT p.id, p.name, p.slug, p."priceCents", p."compareAtCents", p.stock, p."trackInventory",
          (SELECT url FROM "ProductImage" WHERE "productId" = p.id ORDER BY position ASC LIMIT 1) AS "thumbnailUrl",
          count(*) OVER() AS total
        FROM "Product" p
        WHERE p."tenantId" = ${tenantId}::uuid AND p.status = 'active'
        ${categoryFilter} ${priceFilter} ${searchFilter}
        ${orderBy}
        LIMIT ${pageSize} OFFSET ${offset}
      `);

      const total = rows[0] ? Number(rows[0].total) : 0;
      const items: StorefrontProductSummary[] = rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        priceCents: r.priceCents,
        compareAtCents: r.compareAtCents,
        thumbnailUrl: r.thumbnailUrl,
        inStock: !r.trackInventory || r.stock > 0,
      }));
      return { items, total, page, pageSize };
    });
  }
}
```

`services/api/src/storefront/products.controller.ts`:
```ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { PublicTenantGuard } from './public-tenant.guard';
import { StorefrontTenantId } from './storefront-tenant.decorator';
import { StorefrontProductsService } from './products.service';

@Controller('v1/storefront/products')
@UseGuards(PublicTenantGuard)
export class StorefrontProductsController {
  constructor(private readonly products: StorefrontProductsService) {}

  @Get()
  list(
    @StorefrontTenantId() tenantId: string,
    @Query('search') search?: string,
    @Query('category') categorySlug?: string,
    @Query('priceMax') priceMax?: string,
    @Query('sort') sort?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.products.list(tenantId, {
      search,
      categorySlug,
      priceMax: priceMax ? Number(priceMax) : undefined,
      sort: sort === 'price' || sort === 'newest' ? sort : 'relevance',
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }
}
```

Register `StorefrontProductsController` + `StorefrontProductsService` in `storefront.module.ts`'s `controllers`/`providers`.

- [ ] **Step 4: Run to verify GREEN**

Run: `pnpm --filter @ventia/api test -- storefront-products`
Expected: PASS (6 tests). Full suite green.

- [ ] **Step 5: Commit**

```bash
git add services/api && git commit -m "feat: add public product search with full-text and trigram matching"
```

---

### Task 3: Product detail endpoint + related products

**Files:**
- Modify: `services/api/src/storefront/products.service.ts`, `products.controller.ts`
- Test: extend `services/api/test/storefront-products.test.ts`

**Interfaces:**
- Produces: `StorefrontProductsService.detail(tenantId, slug): Promise<StorefrontProductDetail | null>` where `StorefrontProductDetail = { id, name, slug, descriptionMd, priceCents, compareAtCents, taxRate, options: string[], images: Array<{ url, alt }>, variants: Array<{ id, option1, option2, option3, priceCents, stock }>, inStock: boolean, related: StorefrontProductSummary[] }`.
- `GET /v1/storefront/products/:slug` → 200 the shape above, or 404 `{ error: 'PRODUCT_NOT_FOUND' }` (also for `draft`/`archived` products — a shopper must never resolve them by slug, matching M2's "archived products keep 404-ing on the storefront" AC carried from P1).

- [ ] **Step 1: Write failing tests**

Extend `services/api/test/storefront-products.test.ts`:
```ts
describe('GET /v1/storefront/products/:slug', () => {
  it('returns full detail for an active product', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products/camiseta-basica')
      .set('x-tenant-domain', 'sf-cat.ventia.localhost');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Camiseta Básica', slug: 'camiseta-basica', inStock: true });
    expect(Array.isArray(res.body.related)).toBe(true);
  });

  it('404s a draft product by slug', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products/borrador')
      .set('x-tenant-domain', 'sf-cat.ventia.localhost');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('PRODUCT_NOT_FOUND');
  });

  it('related products exclude self and other-category items, cap at 4', async () => {
    const cat = await prisma.category.findFirstOrThrow({ where: { tenantId: liveTenantId, slug: 'ropa' } });
    const target = await prisma.product.findFirstOrThrow({ where: { tenantId: liveTenantId, slug: 'camiseta-basica' } });
    await prisma.productCategory.create({ data: { tenantId: liveTenantId, productId: target.id, categoryId: cat.id } });
    for (let i = 0; i < 5; i += 1) {
      const p = await prisma.product.create({
        data: { tenantId: liveTenantId, name: `Relacionado ${i}`, slug: `relacionado-${i}`, priceCents: 10000, status: 'active' },
      });
      await prisma.productCategory.create({ data: { tenantId: liveTenantId, productId: p.id, categoryId: cat.id } });
    }
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products/camiseta-basica')
      .set('x-tenant-domain', 'sf-cat.ventia.localhost');
    expect(res.body.related.length).toBeLessThanOrEqual(4);
    expect(res.body.related.every((r: { slug: string }) => r.slug !== 'camiseta-basica')).toBe(true);
  });
});
```

- [ ] **Step 2: RED**

Run: `pnpm --filter @ventia/api test -- storefront-products`
Expected: FAIL — `detail` not implemented, route 404s generically.

- [ ] **Step 3: Implement**

Add to `products.service.ts`:
```ts
export interface StorefrontProductDetail extends Omit<StorefrontProductSummary, 'thumbnailUrl'> {
  descriptionMd: string;
  images: Array<{ url: string; alt: string | null }>;
  variants: Array<{ id: string; option1: string | null; option2: string | null; option3: string | null; priceCents: number | null; stock: number }>;
  options: string[];
  related: StorefrontProductSummary[];
}
```
```ts
  async detail(tenantId: string, slug: string): Promise<StorefrontProductDetail | null> {
    const db = tenantDb(tenantId);
    const product = await db.product.findFirst({
      where: { slug, status: 'active' },
      include: {
        images: { orderBy: { position: 'asc' } },
        variants: true,
        categories: { select: { categoryId: true } },
      },
    });
    if (!product) return null;

    const categoryIds = product.categories.map((c) => c.categoryId);
    const related = categoryIds.length
      ? await db.product.findMany({
          where: {
            status: 'active',
            id: { not: product.id },
            categories: { some: { categoryId: { in: categoryIds } } },
          },
          take: 4,
          orderBy: { createdAt: 'desc' },
          include: { images: { orderBy: { position: 'asc' }, take: 1 } },
        })
      : [];

    return {
      id: product.id,
      name: product.name,
      slug: product.slug,
      descriptionMd: product.descriptionMd,
      priceCents: product.priceCents,
      compareAtCents: product.compareAtCents,
      inStock: !product.trackInventory || product.stock > 0,
      options: product.options,
      images: product.images.map((i) => ({ url: i.url, alt: i.alt })),
      variants: product.variants.map((v) => ({
        id: v.id, option1: v.option1, option2: v.option2, option3: v.option3,
        priceCents: v.priceCents, stock: v.stock,
      })),
      related: related.map((r) => ({
        id: r.id, name: r.name, slug: r.slug, priceCents: r.priceCents, compareAtCents: r.compareAtCents,
        thumbnailUrl: r.images[0]?.url ?? null,
        inStock: !r.trackInventory || r.stock > 0,
      })),
    };
  }
```
Add `import { tenantDb } from '@ventia/db';` alongside the existing `platformDb` import. Add to `products.controller.ts`:
```ts
  @Get(':slug')
  async detail(@StorefrontTenantId() tenantId: string, @Param('slug') slug: string) {
    const detail = await this.products.detail(tenantId, slug);
    if (!detail) throw new NotFoundException({ error: 'PRODUCT_NOT_FOUND' });
    return detail;
  }
```
(Add `NotFoundException`, `Param` to the `@nestjs/common` import line. Route order: Nest matches `:slug` only after the more specific `list` handler's own path segment count — `GET /v1/storefront/products` vs `GET /v1/storefront/products/:slug` do not collide since one has zero extra segments and the other has one; no reordering needed, but verify with a quick manual check if the test suite disagrees.)

- [ ] **Step 4: GREEN**

Run: `pnpm --filter @ventia/api test -- storefront-products` → PASS (9 tests). Full suite green.

- [ ] **Step 5: Commit**

```bash
git add services/api && git commit -m "feat: add public product detail endpoint with related products"
```

---

### Task 4: On-demand ISR revalidation wiring

**Files:**
- Create: `apps/storefront/app/api/revalidate/route.ts`
- Create: `services/api/src/storefront/revalidate.ts`
- Modify: `services/api/src/catalog/products.service.ts` (create/update/archive), `services/api/src/catalog/categories.controller.ts` (create/update/delete)
- Modify: `packages/core/src/env.ts`, `.env.example`
- Test: `apps/storefront/test/revalidate-route.test.ts`, extend one existing catalog test to assert the fire-and-forget call is attempted (mock `fetch`).

**Interfaces:**
- Env: `REVALIDATE_SECRET` (string, default `'dev-revalidate-secret'`), `STOREFRONT_INTERNAL_URL` (url, default `http://localhost:3000`).
- `services/api/src/storefront/revalidate.ts` exports `revalidateStorefrontTag(tag: string): void` — fire-and-forget POST, catches and logs, never throws, never awaited by callers (mutations must not slow down or fail on a storefront hiccup).
- `POST /api/revalidate` (Next.js Route Handler) body `{ tag: string; secret: string }` → wrong secret → 401; else `revalidateTag(tag)` + `{ revalidated: true }`.

- [ ] **Step 1: Write failing tests**

`apps/storefront/test/revalidate-route.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }));

import { revalidateTag } from 'next/cache';
import { POST } from '../app/api/revalidate/route';

describe('POST /api/revalidate', () => {
  it('revalidates the tag when the secret matches', async () => {
    process.env.REVALIDATE_SECRET = 'test-secret';
    const req = new Request('http://localhost/api/revalidate', {
      method: 'POST',
      body: JSON.stringify({ tag: 'products:t1', secret: 'test-secret' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(revalidateTag).toHaveBeenCalledWith('products:t1');
  });

  it('401s on a wrong secret', async () => {
    process.env.REVALIDATE_SECRET = 'test-secret';
    const req = new Request('http://localhost/api/revalidate', {
      method: 'POST',
      body: JSON.stringify({ tag: 'products:t1', secret: 'wrong' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: RED**

Run: `pnpm --filter @ventia/storefront test -- revalidate-route`
Expected: FAIL — route not found.

- [ ] **Step 3: Implement**

`packages/core/src/env.ts` additions:
```ts
REVALIDATE_SECRET: z.string().min(1).default('dev-revalidate-secret'),
STOREFRONT_INTERNAL_URL: z.string().url().default('http://localhost:3000'),
```
Append both to `.env.example`.

`apps/storefront/app/api/revalidate/route.ts`:
```ts
import { revalidateTag } from 'next/cache';

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { tag?: string; secret?: string };
  const expected = process.env.REVALIDATE_SECRET ?? 'dev-revalidate-secret';
  if (body.secret !== expected) {
    return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  if (!body.tag) {
    return Response.json({ error: 'VALIDATION_FAILED' }, { status: 400 });
  }
  revalidateTag(body.tag);
  return Response.json({ revalidated: true });
}
```

`services/api/src/storefront/revalidate.ts`:
```ts
/**
 * Fire-and-forget on-demand ISR revalidation. Never awaited by callers and
 * never throws: a storefront that's down (e.g. a dev session that only ran
 * the API) must not slow down or fail an otherwise-successful admin mutation.
 * The page's own `revalidate` + tag config is the fallback if this is missed.
 */
export function revalidateStorefrontTag(tag: string): void {
  const url = process.env.STOREFRONT_INTERNAL_URL ?? 'http://localhost:3000';
  const secret = process.env.REVALIDATE_SECRET ?? 'dev-revalidate-secret';
  fetch(`${url}/api/revalidate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tag, secret }),
  }).catch((err: unknown) => {
    console.warn('[revalidate] storefront unreachable', err instanceof Error ? err.message : err);
  });
}
```

Wire calls: in `products.service.ts`, after `create`/`update`/archive (`delete` handler) succeed, call `revalidateStorefrontTag(\`products:${session.tenantId}\`)`. In `categories.controller.ts`, after create/update/delete, call `revalidateStorefrontTag(\`categories:${session.tenantId}\`)`. Import from `'../storefront/revalidate'`. Place the call AFTER `writeAudit` (mutation success is already committed at that point) — one line per mutation handler, no refactor of the handlers' control flow.

- [ ] **Step 4: GREEN**

Run: `pnpm --filter @ventia/storefront test -- revalidate-route` → PASS (2). Extend one products.test.ts case with a `vi.spyOn(global, 'fetch')` assertion that create triggers a fetch to `/api/revalidate` (mock the fetch to resolve immediately so the test doesn't hang on the real network call). Full workspace suite green.

- [ ] **Step 5: Commit**

```bash
git add services/api apps/storefront packages/core .env.example && git commit -m "feat: wire on-demand ISR revalidation from catalog mutations"
```

---

### Task 5: Storefront shell — theming, fonts, api client, shared components

**Files:**
- Create: `apps/storefront/lib/storefront-api.ts`, `lib/theme.ts`, `lib/format.ts`, `lib/policy-defaults.ts`, `components/product-card.tsx`, `components/product-grid.tsx`, `components/price.tsx`
- Modify: `apps/storefront/app/layout.tsx`, `apps/storefront/lib/tenant.ts` (extend `ResolvedTenant` fetch to also return `theme`)
- Modify: `services/api/src/tenants/tenant.controller.ts` (the existing `GET /v1/tenant` gains `theme` in its response — it's the same read `AdminMeController`/`SettingsController` already expose, just surfaced on the public endpoint too)
- Test: `apps/storefront/test/theme.test.ts`, `apps/storefront/test/format.test.ts`

**Interfaces:**
- `buildThemeVars(theme: TenantTheme | null): Record<string, string>` — CSS custom-property map (`--color-primary`, `--color-background`, `--color-foreground`, `--radius`) with sensible neutral defaults when `theme` is null (draft tenant with no branding saved yet).
- `formatCOP(cents: number): string` — same convention as the admin app's (`Math.round(cents/100)`, es-CO, NBSP normalized to space, e.g. `4590000 → "$ 45.900"`) — a local copy per the design doc's YAGNI note (8 lines, not worth a shared package).
- `policyDefault(type): { title: string; bodyMd: string }` — es-CO fallback copy for the 4 policy types, used when `/v1/storefront/content/:type` 404s.
- `apps/storefront/lib/storefront-api.ts`: `fetchStorefront<T>(tenantHost: string, path: string): Promise<T | null>` (null on 404; throws `StorefrontApiError` with `.status` on other non-2xx, e.g. 503 for suspended — the calling page decides how to render that).

- [ ] **Step 1: Write failing tests**

`apps/storefront/test/theme.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildThemeVars } from '../lib/theme';

describe('buildThemeVars', () => {
  it('maps a saved theme to CSS variables', () => {
    const vars = buildThemeVars({
      colors: { primary: '#4f46e5', background: '#ffffff', foreground: '#111827' },
      fontPair: 'inter-lora', radius: 'md', logoUrl: '', faviconUrl: '',
    });
    expect(vars['--color-primary']).toBe('#4f46e5');
    expect(vars['--radius']).toBe('0.5rem');
  });

  it('falls back to neutral defaults when no theme is saved', () => {
    const vars = buildThemeVars(null);
    expect(vars['--color-primary']).toBeTruthy();
    expect(vars['--radius']).toBeTruthy();
  });
});
```

`apps/storefront/test/format.test.ts` (identical golden cases to the admin app's `formatCOP` — 4590000 → "$ 45.900", 0 → "$ 0", 12990000 → "$ 129.900", 150 → "$ 2").

- [ ] **Step 2: RED**

Run: `pnpm --filter @ventia/storefront test -- theme format`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`apps/storefront/lib/theme.ts`:
```ts
export interface TenantTheme {
  colors: { primary: string; background: string; foreground: string };
  fontPair: string;
  radius: 'none' | 'sm' | 'md' | 'lg' | 'full';
  logoUrl?: string;
  faviconUrl?: string;
}

const RADIUS_REM: Record<TenantTheme['radius'], string> = {
  none: '0px', sm: '0.25rem', md: '0.5rem', lg: '1rem', full: '9999px',
};

const DEFAULT_THEME: TenantTheme = {
  colors: { primary: '#4f46e5', background: '#ffffff', foreground: '#111827' },
  fontPair: 'inter-lora',
  radius: 'md',
};

export function buildThemeVars(theme: TenantTheme | null): Record<string, string> {
  const t = theme ?? DEFAULT_THEME;
  return {
    '--color-primary': t.colors.primary,
    '--color-background': t.colors.background,
    '--color-foreground': t.colors.foreground,
    '--radius': RADIUS_REM[t.radius],
  };
}
```

`apps/storefront/lib/format.ts` (copy from `apps/admin/lib/format.ts`'s `formatCOP` verbatim — same NBSP-normalization approach; do not import cross-app).

`apps/storefront/lib/policy-defaults.ts`:
```ts
export const POLICY_DEFAULTS: Record<'policy_shipping' | 'policy_returns' | 'policy_privacy' | 'about', { title: string; bodyMd: string }> = {
  policy_shipping: { title: 'Envíos', bodyMd: 'Esta tienda aún no ha configurado su política de envíos.' },
  policy_returns: { title: 'Cambios y devoluciones', bodyMd: 'Esta tienda aún no ha configurado su política de cambios y devoluciones.' },
  policy_privacy: { title: 'Privacidad', bodyMd: 'Esta tienda aún no ha configurado su política de privacidad.' },
  about: { title: 'Contacto', bodyMd: 'Esta tienda aún no ha configurado su información de contacto.' },
};
```

`apps/storefront/lib/storefront-api.ts`:
```ts
export class StorefrontApiError extends Error {
  constructor(public readonly status: number) {
    super(`storefront api error ${status}`);
  }
}

export async function fetchStorefront<T>(
  tenantHost: string,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T | null> {
  const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
  const res = await fetchImpl(`${apiUrl}${path}`, {
    headers: { 'x-tenant-domain': tenantHost },
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new StorefrontApiError(res.status);
  return (await res.json()) as T;
}
```

Extend `apps/storefront/lib/tenant.ts`'s `ResolvedTenant` with `theme: unknown` (whatever `GET /v1/tenant` now returns — a small addition to `services/api/src/tenants/tenant.controller.ts`'s response object: spread `tenant.theme` in). `apps/storefront/app/layout.tsx` becomes async, reads the resolved tenant (same `headers()` + `fetchTenantForHost` pattern as `page.tsx` already uses) and applies `buildThemeVars` as an inline `style` attribute on `<html>`.

`components/price.tsx`:
```tsx
import { formatCOP } from '../lib/format';

export function Price({ cents, compareAtCents }: { cents: number; compareAtCents?: number | null }) {
  return (
    <span>
      <span className="font-semibold">{formatCOP(cents)}</span>
      {compareAtCents && compareAtCents > cents ? (
        <span className="ml-2 text-sm line-through opacity-60">{formatCOP(compareAtCents)}</span>
      ) : null}
    </span>
  );
}
```

`components/product-card.tsx` + `product-grid.tsx`: a `Card`-based (from `@ventia/ui`) product tile (thumbnail, name, `<Price>`, link to `/productos/[slug]`) and a responsive grid wrapper — straightforward Tailwind, no new logic to test.

- [ ] **Step 4: GREEN**

Run: `pnpm --filter @ventia/storefront test` → PASS. `pnpm --filter @ventia/api test -- tenant-endpoint` still green (theme addition is additive, doesn't change existing assertions — extend one test to check `theme` key presence if convenient, not required).

- [ ] **Step 5: Commit**

```bash
git add apps/storefront services/api/src/tenants && git commit -m "feat: add storefront theming, price formatting, and api client"
```

---

### Task 6: Home + category listing pages

**Files:**
- Modify: `apps/storefront/app/page.tsx`
- Create: `apps/storefront/app/categorias/[slug]/page.tsx`

**Interfaces:**
- Consumes: Tasks 1/2/5 (`fetchStorefront`, `ProductGrid`, `/v1/storefront/categories`, `/v1/storefront/products`).
- Home: hero (tenant name + a static "Bienvenido" line — no hero image config exists yet, out of scope), category tiles (from `/v1/storefront/categories`), "Novedades" grid (products sorted `newest`, first 8). Preserves the existing unknown-host/suspended/draft-tenant branches from the current `page.tsx` (suspended already renders the P1 message; **replace with the real 503 now — Task 1's guard is what a *browser* hitting an unresolved API route gets, but this server component fetches via `fetchStorefront`, which will throw `StorefrontApiError(503)`; catch it here and call Next's `notFound()`? No — 503 must stay 503, not 404. Use a route-level solution: catch the error and render the same "no disponible" copy, but this time actually return an HTTP 503 by throwing the error up to a `error.tsx` boundary configured to read a `status` from the thrown error — OR the simpler, spec-honest fix: keep this page a Server Component that sets the response status via `NextResponse`? App Router page components cannot set arbitrary status codes directly.** Resolution: add `apps/storefront/app/error.tsx` won't carry a custom status either (client-rendered error boundary, still 200 in the initial document). The only App-Router-native way to emit a non-200 from a page is `notFound()` (404) or `redirect()`, neither of which is 503. **Accept a scoped, documented exception to the design doc's "real 503" plan**: implement it via a root `middleware.ts` that pre-checks tenant status (one extra fetch to `/v1/tenant`) and returns `new Response(..., { status: 503 })` directly for a suspended tenant, before Next.js routes to any page component — this is the one mechanism that genuinely sets the status code. Add `apps/storefront/middleware.ts`:
```ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export async function middleware(req: NextRequest) {
  const host = req.headers.get('host');
  if (!host) return NextResponse.next();
  const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
  try {
    const res = await fetch(`${apiUrl}/v1/tenant`, { headers: { 'x-tenant-domain': host } });
    if (res.status === 200) {
      const tenant = (await res.json()) as { status: string };
      if (tenant.status === 'suspended') {
        return new NextResponse('<html><body><h1>Tienda temporalmente no disponible</h1></body></html>', {
          status: 503,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
    }
  } catch {
    // API unreachable — let the request fall through to the page, which has its own unknown-tenant handling.
  }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'] };
```
This closes the P1 "503 deviation" backlog item for real. Remove the old suspended-branch comment/block from `page.tsx` (dead code once middleware short-circuits it) but keep an unknown-tenant (404 domain, not suspended) branch — that one stays a normal 200 platform-landing page, unchanged from P0/P1.

- [ ] **Step 1**: No new pure-logic helper here (page composition, not logic) — skip RED/GREEN unit cycle for this task; verify via manual dev-server check in Step 3.

- [ ] **Step 2**: Implement `middleware.ts` (above) + rewrite `app/page.tsx` to use `fetchStorefront`/`ProductGrid`/categories, and `app/categorias/[slug]/page.tsx` (fetch `/v1/storefront/products?category=slug`, `notFound()` if the category slug resolves to zero categories AND zero products — actually categories list doesn't expose a single-lookup; simplest: fetch the full categories list, find by slug client-side in the server component, `notFound()` if absent, else render products filtered by that slug).

- [ ] **Step 3: Manual verification**

With the dev stack up and a seeded live tenant: `curl -s http://demo-moda.ventia.localhost/` shows category tiles + products; suspended-tenant curl returns `-o /dev/null -w '%{http_code}'` → `503`.

- [ ] **Step 4: Commit**

```bash
git add apps/storefront && git commit -m "feat: add storefront home and category listing pages with real 503 for suspended tenants"
```

---

### Task 7: PDP + search page

**Files:**
- Create: `apps/storefront/app/productos/[slug]/page.tsx`, `apps/storefront/app/buscar/page.tsx`

**Interfaces:**
- Consumes: Task 3's detail endpoint, Task 2's list endpoint, Task 5's components.
- PDP: gallery (images, fallback placeholder if none), variant selector (native `<select>` per option label when `options.length > 0`), stock-state badge (En stock / Agotado — never exact numbers, per spec's storefront-never-leaks-inventory posture), inert "Agregar al carrito" `Button` (`disabled`, tooltip/title "Disponible próximamente" — P2b enables it), related-products grid, `notFound()` on null detail.
- Search page: reads `?q=`, calls the list endpoint with `search`, renders `ProductGrid` + an input to refine, empty-state es-CO copy ("No encontramos productos para «{q}»").

- [ ] **Step 1-2**: Implement per the interfaces above (no new pure helpers — composition only).
- [ ] **Step 3: Manual verification**: visit a seeded product's PDP and `/buscar?q=camiseta` against the dev stack; confirm variant selector renders when a product has `options`.
- [ ] **Step 4: Commit**

```bash
git add apps/storefront && git commit -m "feat: add product detail and search pages"
```

---

### Task 8: Policy pages + 404 + SEO

**Files:**
- Create: `apps/storefront/app/envios/page.tsx`, `cambios-y-devoluciones/page.tsx`, `privacidad/page.tsx`, `contacto/page.tsx`, `not-found.tsx`, `sitemap.ts`, `robots.ts`
- Modify: PDP page (Task 7) to add `generateMetadata` (OpenGraph) + JSON-LD `<script type="application/ld+json">`

**Interfaces:**
- Each policy page: `fetchStorefront<{title,bodyMd}>('/v1/storefront/content/:type')`, falls back to `POLICY_DEFAULTS[type]` on null; renders `bodyMd` as plain paragraphs (no markdown renderer dependency added — split on double-newline, YAGNI: a real Markdown renderer is a P2c-or-later nicety if merchants start writing rich policy text).
- `sitemap.ts`: `MetadataRoute.Sitemap` — fetches all active products + categories for the current tenant (resolved via `headers()`), one entry per PDP/category + static pages.
- `robots.ts`: allow all, sitemap URL.
- `not-found.tsx`: es-CO "Página no encontrada" + link home.
- JSON-LD: `Product` schema.org object per PDP (name, image, offers.price in COP, availability).

- [ ] **Step 1-2**: Implement per interfaces (no new pure helpers).
- [ ] **Step 3: Manual verification**: `curl http://demo-moda.ventia.localhost/sitemap.xml` returns valid XML listing seeded products; view-source a PDP for the JSON-LD script tag.
- [ ] **Step 4: Commit**

```bash
git add apps/storefront && git commit -m "feat: add policy pages, sitemap, robots, and product structured data"
```

---

### Task 9: P2a wrap-up — full gate + manual smoke + docs

**Files:**
- Modify: `README.md` (≤ 10 lines: storefront endpoints note, `REVALIDATE_SECRET`/`STOREFRONT_INTERNAL_URL` env vars, real-503 note replacing the old P1 deviation line)

**Steps:**
- [ ] Run `pnpm turbo run lint typecheck build` + `pnpm turbo run test` — green (api grows by ~15 tests, storefront by ~6).
- [ ] Manual smoke against the dev stack: browse home → category → PDP → search → each policy page → sitemap.xml/robots.txt, for a seeded live tenant; confirm a suspended tenant (flip one via `platformDb` in a scratch script) returns real HTTP 503; confirm archived/draft products 404 on their PDP URL.
- [ ] README update + commit `docs: document storefront endpoints and real 503 for suspended tenants`.

---

## Self-Review Notes

- **Spec coverage:** M3's page list (home, category, PDP, cart[P2b], checkout[P2b], confirmation[P2b], tracking[P2c], policy pages, 404) — everything except cart/checkout/tracking is covered here, correctly deferred per the sub-phase split. Search (FTS+trigram) — Task 2. SEO (sitemap/robots/JSON-LD/OG) — Task 8. Mobile-first/Lighthouse — noted as manual-check-only in the design (no CI budget exists yet); ISR tag revalidation within 60s — Task 4.
- **Known judgment calls:** the real-503 mechanism required a `middleware.ts` fetch rather than a page-level status (App Router constraint) — this is a genuine architectural finding, not a shortcut; flagged inline where it's decided (Task 6) rather than left implicit. `formatCOP` is duplicated (admin + storefront) by deliberate YAGNI choice, consistent with the P1c precedent of not sharing an 8-line pure function across apps for its own sake.
- **Type consistency:** `StorefrontProductSummary`/`StorefrontProductDetail` used consistently between `products.service.ts` (Tasks 2-3) and the storefront `ProductGrid`/PDP components (Tasks 5-7) — no shape drift.
- Prisma raw-SQL fragment composition (Task 2) is flagged for implementation-time verification against the installed version, per the global constraints — do not transcribe it blindly if the installed Prisma 6.x rejects nested `Prisma.sql` fragments in that position.
