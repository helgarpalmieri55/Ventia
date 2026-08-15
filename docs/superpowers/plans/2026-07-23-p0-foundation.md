# P0 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multi-tenant foundation for Ventia: monorepo, dev environment, full Prisma schema with two-layer tenant isolation (RLS + scoped client), better-auth, tenant resolution by domain, seed, and CI.

**Architecture:** Turborepo monorepo (spec §12). Postgres RLS is the hard isolation guarantee; a Prisma client extension (`tenantDb`) sets the `app.tenant_id` GUC + a non-owner role per transaction and injects tenant scoping. The API (NestJS) resolves tenants from the `Host` header with a Redis cache; the storefront (Next.js) asks the API for the resolved tenant.

**Tech Stack:** Node 22 · pnpm 9 · TypeScript strict · Turborepo 2 · Prisma 6 + Postgres 16 (pgvector image) · Redis 7 · NestJS 10 · Next.js 15 (React 19) · better-auth 1 · Zod 3 · Vitest 2 + Testcontainers · GitHub Actions.

## Global Constraints (spec §4)

- Node 22 LTS · pnpm 9 (pin via `"packageManager": "pnpm@9.15.0"`; if corepack cannot fetch it in this environment, use installed pnpm 10 and record the deviation in the README) · TypeScript `strict: true` · Next.js 15.x · NestJS 10.x · Prisma 6.x.
- Money: integer COP cents everywhere (`priceCents` etc.). No floats.
- Language: code, comments, commits, docs in English. Storefront copy es-CO.
- Tenant isolation: every tenant-data table has `tenantId`; RLS enforced; app code uses the tenant-scoped client. Unscoped access only via explicit `platformDb`.
- TDD with Vitest + Testcontainers. Conventional commits. CI green before merge.
- Naming convention decision: Prisma default naming (PascalCase tables, camelCase columns). Spec §8's snake_case names are conceptual; RLS SQL quotes the Prisma-generated identifiers.

---

## File Structure (end state of P0)

```
ventia/
├── apps/
│   ├── storefront/            # Next 15: tenant home or platform landing by Host
│   └── admin/                 # Next 15: placeholder page
├── services/api/              # NestJS: health, tenant resolution, auth
├── packages/
│   ├── db/                    # Prisma schema, migrations (incl. RLS), tenantDb/platformDb
│   ├── core/                  # Zod env schema, shared domain constants/types
│   ├── payments/              # PaymentProvider interface only
│   └── ui/                    # placeholder
├── docker/compose.yaml + Caddyfile
├── .github/workflows/ci.yml
└── turbo.json, pnpm-workspace.yaml, tsconfig.base.json, eslint.config.mjs
```

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc.json`, `.gitignore`, `.env.example`

**Interfaces:**
- Produces: workspace globs `apps/*`, `services/*`, `packages/*`; turbo tasks `lint`, `typecheck`, `test`, `build`; base tsconfig path `../../tsconfig.base.json`.

- [ ] **Step 1: Create root files**

`package.json`:
```json
{
  "name": "ventia",
  "private": true,
  "packageManager": "pnpm@9.15.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "build": "turbo run build"
  },
  "devDependencies": {
    "turbo": "^2.3.0",
    "typescript": "^5.6.0",
    "eslint": "^9.15.0",
    "typescript-eslint": "^8.15.0",
    "prettier": "^3.3.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "services/*"
  - "packages/*"
```

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "lint": {},
    "typecheck": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"] }
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true
  }
}
```

`eslint.config.mjs`:
```js
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/.next/**", "**/node_modules/**", "**/generated/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  }
);
```

`.prettierrc.json`:
```json
{ "singleQuote": true, "trailingComma": "all", "printWidth": 100 }
```

`.gitignore`:
```
node_modules/
dist/
.next/
.turbo/
.env
*.tsbuildinfo
coverage/
```

`.env.example`:
```
DATABASE_URL=postgresql://ventia:ventia@localhost:5432/ventia
REDIS_URL=redis://localhost:6379
AUTH_SECRET=dev-secret-change-me
API_PORT=4000
API_URL=http://api.ventia.localhost
PLATFORM_ROOT_DOMAIN=ventia.localhost
```

- [ ] **Step 2: Verify install**

Run: `corepack enable && pnpm install` (fallback: system pnpm 10, note deviation)
Expected: lockfile created, no errors. `pnpm turbo run lint` → "no tasks found" (no packages yet) exits 0.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: scaffold turborepo monorepo"
```

---

### Task 2: Dev environment (Docker Compose + Caddy)

**Files:**
- Create: `docker/compose.yaml`, `docker/Caddyfile`

**Interfaces:**
- Produces: Postgres at `localhost:5432` (db/user/pass `ventia`), Redis at `localhost:6379`, Caddy on `:80` proxying `*.ventia.localhost` → storefront (host :3000), `admin.ventia.localhost` → :3001, `api.ventia.localhost` → :4000.

- [ ] **Step 1: Create compose file**

`docker/compose.yaml`:
```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: ventia
      POSTGRES_PASSWORD: ventia
      POSTGRES_DB: ventia
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
  caddy:
    image: caddy:2-alpine
    ports: ["80:80"]
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro"]
    extra_hosts: ["host.docker.internal:host-gateway"]
volumes:
  pgdata:
```

`docker/Caddyfile`:
```
http://api.ventia.localhost {
	reverse_proxy host.docker.internal:4000
}
http://admin.ventia.localhost {
	reverse_proxy host.docker.internal:3001
}
http://ventia.localhost, http://*.ventia.localhost {
	reverse_proxy host.docker.internal:3000
}
```

- [ ] **Step 2: Verify services**

Run: `docker compose -f docker/compose.yaml up -d && docker compose -f docker/compose.yaml ps`
Expected: 3 services running. `docker exec $(docker compose -f docker/compose.yaml ps -q postgres) pg_isready -U ventia` → "accepting connections".

- [ ] **Step 3: Commit**

```bash
git add docker && git commit -m "chore: add dev docker compose (postgres, redis, caddy)"
```

---

### Task 3: Shared packages — core, payments, ui

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/src/env.ts`, `packages/core/src/tenant.ts`, `packages/core/test/env.test.ts`, `packages/core/vitest.config.ts`
- Create: `packages/payments/package.json`, `packages/payments/tsconfig.json`, `packages/payments/src/index.ts`
- Create: `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/src/index.ts`

**Interfaces:**
- Produces: `@ventia/core` exports `loadEnv(): Env` (Zod-validated process env), types `TenantStatus`, `PlanId`, `MembershipRole`, const `PLANS`. `@ventia/payments` exports `PaymentProvider` interface. All packages build with `tsc` to `dist/`.

- [ ] **Step 1: Write failing env test**

`packages/core/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node' } });
```

`packages/core/test/env.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env';

describe('loadEnv', () => {
  it('parses a valid environment', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      AUTH_SECRET: 'secret',
      PLATFORM_ROOT_DOMAIN: 'ventia.localhost',
    });
    expect(env.PLATFORM_ROOT_DOMAIN).toBe('ventia.localhost');
    expect(env.API_PORT).toBe(4000); // default
  });

  it('throws on missing DATABASE_URL', () => {
    expect(() => loadEnv({ AUTH_SECRET: 'x' })).toThrow(/DATABASE_URL/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ventia/core test` (after creating package.json below)
Expected: FAIL — `../src/env` not found.

- [ ] **Step 3: Implement core package**

`packages/core/package.json`:
```json
{
  "name": "@ventia/core",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src test",
    "test": "vitest run"
  },
  "dependencies": { "zod": "^3.23.0" },
  "devDependencies": { "vitest": "^2.1.0" }
}
```

`packages/core/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`packages/core/src/env.ts`:
```ts
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  AUTH_SECRET: z.string().min(1),
  API_PORT: z.coerce.number().int().default(4000),
  API_URL: z.string().url().default('http://api.ventia.localhost'),
  PLATFORM_ROOT_DOMAIN: z.string().min(1).default('ventia.localhost'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment: ${missing}`);
  }
  return parsed.data;
}
```

`packages/core/src/tenant.ts`:
```ts
export type TenantStatus = 'draft' | 'live' | 'suspended';
export type PlanId = 'basico' | 'pro' | 'premium';
export type MembershipRole = 'owner' | 'staff' | 'platform_admin';

export interface PlanLimits {
  productsMax: number;
  aiMessagesMonth: number;
  staffSeats: number;
  customDomain: boolean;
  humanHandoff: boolean;
  whatsappChannel: boolean;
}

export const PLANS: Record<PlanId, PlanLimits> = {
  basico: { productsMax: 100, aiMessagesMonth: 500, staffSeats: 1, customDomain: false, humanHandoff: false, whatsappChannel: false },
  pro: { productsMax: 1000, aiMessagesMonth: 3000, staffSeats: 3, customDomain: true, humanHandoff: false, whatsappChannel: true },
  premium: { productsMax: 10000, aiMessagesMonth: 10000, staffSeats: 10, customDomain: true, humanHandoff: true, whatsappChannel: true },
};
```

`packages/core/src/index.ts`:
```ts
export * from './env';
export * from './tenant';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm --filter @ventia/core test`
Expected: PASS (2 tests).

- [ ] **Step 5: Create payments + ui packages**

`packages/payments/package.json`:
```json
{
  "name": "@ventia/payments",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": { "build": "tsc", "typecheck": "tsc --noEmit", "lint": "eslint src" }
}
```

`packages/payments/tsconfig.json`: same shape as core's.

`packages/payments/src/index.ts` (spec §6 M5, interface only in P0):
```ts
export type PaymentProviderId = 'wompi' | 'mercadopago' | 'epayco';

export interface OrderForPayment {
  orderId: string;
  orderNumber: string;
  totalCents: number;
  customerEmail: string;
}

export interface TenantProviderConfig {
  publicKey: string;
  privateKey: string;
  sandbox: boolean;
}

export interface RawRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
}

export type NormalizedStatus = 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED';

export interface NormalizedPaymentEvent {
  provider: PaymentProviderId;
  eventId: string;
  providerRef: string;
  status: NormalizedStatus;
  amountCents: number;
}

export interface PaymentProvider {
  readonly id: PaymentProviderId;
  createCheckoutSession(order: OrderForPayment, cfg: TenantProviderConfig): Promise<{ redirectUrl: string }>;
  verifyAndParseWebhook(req: RawRequest, cfg: TenantProviderConfig): Promise<NormalizedPaymentEvent>;
  getTransactionStatus(providerRef: string, cfg: TenantProviderConfig): Promise<NormalizedStatus>;
  refund?(providerRef: string, amountCents: number, cfg: TenantProviderConfig): Promise<void>;
}
```

`packages/ui/package.json`: same shape, name `@ventia/ui`. `packages/ui/src/index.ts`:
```ts
export const UI_PACKAGE_PLACEHOLDER = true; // components arrive in P1/P2
```

- [ ] **Step 6: Verify build & commit**

Run: `pnpm build && pnpm typecheck`
Expected: all packages build.

```bash
git add packages && git commit -m "feat: add core env/domain types and PaymentProvider interface"
```

---

### Task 4: packages/db — Prisma schema v1 + initial migration

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/prisma/schema.prisma`, `packages/db/src/index.ts`, `packages/db/vitest.config.ts`

**Interfaces:**
- Produces: `@ventia/db` exports `prisma` (base PrismaClient) and all Prisma types; migration `0_init` creating every §8 table. Script `pnpm --filter @ventia/db generate|migrate:dev|migrate:deploy`.

- [ ] **Step 1: Create package files**

`packages/db/package.json`:
```json
{
  "name": "@ventia/db",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src test",
    "test": "vitest run",
    "generate": "prisma generate",
    "migrate:dev": "prisma migrate dev",
    "migrate:deploy": "prisma migrate deploy"
  },
  "dependencies": { "@prisma/client": "^6.0.0" },
  "devDependencies": {
    "prisma": "^6.0.0",
    "vitest": "^2.1.0",
    "testcontainers": "^10.13.0",
    "@testcontainers/postgresql": "^10.13.0"
  }
}
```

`packages/db/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', hookTimeout: 120_000, testTimeout: 60_000 } });
```

- [ ] **Step 2: Write the full schema**

`packages/db/prisma/schema.prisma` (all §8 tables; money = Int cents):
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum TenantStatus { draft live suspended }
enum Plan { basico pro premium }
enum MembershipRole { owner staff platform_admin }
enum ProductStatus { draft active archived }
enum TaxRate {
  ZERO     @map("0")
  FIVE     @map("5")
  NINETEEN @map("19")
  EXCLUIDO @map("excluido")
}
enum OrderStatus { PENDING CONFIRMED PREPARING SHIPPED DELIVERED CANCELLED }
enum PaymentStatus { PENDING PAID FAILED EXPIRED COD }
enum CartSource { web agent }
enum ConversationChannel { web whatsapp }
enum TenantContentType { faq policy_shipping policy_returns policy_privacy about }

model Tenant {
  id          String       @id @default(uuid()) @db.Uuid
  slug        String       @unique
  name        String
  status      TenantStatus @default(draft)
  plan        Plan         @default(basico)
  theme       Json?
  agentConfig Json?
  settings    Json?
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt

  domains       TenantDomain[]
  limits        TenantLimits?
  memberships   Membership[]
  categories    Category[]
  products      Product[]
  carts         Cart[]
  customers     Customer[]
  orders        Order[]
  conversations Conversation[]
  contents      TenantContent[]
  subscriptions Subscription[]
}

model TenantDomain {
  id         String    @id @default(uuid()) @db.Uuid
  tenantId   String    @db.Uuid
  domain     String    @unique
  isPrimary  Boolean   @default(false)
  verifiedAt DateTime?
  tenant     Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId])
}

model TenantLimits {
  tenantId        String  @id @db.Uuid
  productsMax     Int
  aiMessagesMonth Int
  staffSeats      Int
  customDomain    Boolean @default(false)
  humanHandoff    Boolean @default(false)
  whatsappChannel Boolean @default(false)
  tenant          Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
}

// ---- better-auth models ----
model User {
  id            String    @id @default(uuid()) @db.Uuid
  name          String
  email         String    @unique
  emailVerified Boolean   @default(false)
  image         String?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  sessions      Session[]
  accounts      Account[]
  memberships   Membership[]
}

model Session {
  id        String   @id @default(uuid()) @db.Uuid
  token     String   @unique
  userId    String   @db.Uuid
  expiresAt DateTime
  ipAddress String?
  userAgent String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
}

model Account {
  id                    String    @id @default(uuid()) @db.Uuid
  accountId             String
  providerId            String
  userId                String    @db.Uuid
  accessToken           String?
  refreshToken          String?
  idToken               String?
  accessTokenExpiresAt  DateTime?
  refreshTokenExpiresAt DateTime?
  scope                 String?
  password              String?
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt
  user                  User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
}

model Verification {
  id         String   @id @default(uuid()) @db.Uuid
  identifier String
  value      String
  expiresAt  DateTime
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
}

model Membership {
  id       String         @id @default(uuid()) @db.Uuid
  userId   String         @db.Uuid
  tenantId String?        @db.Uuid
  role     MembershipRole
  user     User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  tenant   Tenant?        @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([userId, tenantId])
}

// ---- Catalog ----
model Category {
  id       String  @id @default(uuid()) @db.Uuid
  tenantId String  @db.Uuid
  name     String
  slug     String
  position Int     @default(0)
  tenant   Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  products ProductCategory[]

  @@unique([tenantId, slug])
}

model Product {
  id             String        @id @default(uuid()) @db.Uuid
  tenantId       String        @db.Uuid
  name           String
  slug           String
  descriptionMd  String        @default("")
  priceCents     Int
  compareAtCents Int?
  costCents      Int?
  sku            String?
  barcode        String?
  stock          Int           @default(0)
  trackInventory Boolean       @default(true)
  taxRate        TaxRate       @default(NINETEEN)
  status         ProductStatus @default(draft)
  seo            Json?
  createdAt      DateTime      @default(now())
  updatedAt      DateTime      @updatedAt
  tenant         Tenant        @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  variants       ProductVariant[]
  images         ProductImage[]
  categories     ProductCategory[]

  @@unique([tenantId, slug])
  @@index([tenantId, status])
}

model ProductCategory {
  productId  String   @db.Uuid
  categoryId String   @db.Uuid
  tenantId   String   @db.Uuid
  product    Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  category   Category @relation(fields: [categoryId], references: [id], onDelete: Cascade)

  @@id([productId, categoryId])
}

model ProductVariant {
  id         String  @id @default(uuid()) @db.Uuid
  tenantId   String  @db.Uuid
  productId  String  @db.Uuid
  option1    String?
  option2    String?
  option3    String?
  priceCents Int?
  sku        String?
  stock      Int     @default(0)
  product    Product @relation(fields: [productId], references: [id], onDelete: Cascade)

  @@index([productId])
}

model ProductImage {
  id        String  @id @default(uuid()) @db.Uuid
  tenantId  String  @db.Uuid
  productId String  @db.Uuid
  url       String
  alt       String?
  position  Int     @default(0)
  product   Product @relation(fields: [productId], references: [id], onDelete: Cascade)

  @@index([productId])
}

model InventoryMovement {
  id        String   @id @default(uuid()) @db.Uuid
  tenantId  String   @db.Uuid
  productId String?  @db.Uuid
  variantId String?  @db.Uuid
  delta     Int
  reason    String
  orderId   String?  @db.Uuid
  actor     String
  createdAt DateTime @default(now())

  @@index([tenantId, createdAt])
}

// ---- Cart / Customers / Orders ----
model Cart {
  id        String     @id @default(uuid()) @db.Uuid
  tenantId  String     @db.Uuid
  cookieKey String
  source    CartSource @default(web)
  expiresAt DateTime?
  createdAt DateTime   @default(now())
  updatedAt DateTime   @updatedAt
  tenant    Tenant     @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  items     CartItem[]

  @@unique([tenantId, cookieKey])
}

model CartItem {
  id        String  @id @default(uuid()) @db.Uuid
  tenantId  String  @db.Uuid
  cartId    String  @db.Uuid
  productId String  @db.Uuid
  variantId String? @db.Uuid
  qty       Int
  cart      Cart    @relation(fields: [cartId], references: [id], onDelete: Cascade)

  @@index([cartId])
}

model Customer {
  id              String  @id @default(uuid()) @db.Uuid
  tenantId        String  @db.Uuid
  email           String?
  phone           String?
  name            String?
  ordersCount     Int     @default(0)
  totalSpentCents Int     @default(0)
  tenant          Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  orders          Order[]

  @@index([tenantId, email])
}

model Order {
  id              String        @id @default(uuid()) @db.Uuid
  tenantId        String        @db.Uuid
  number          Int
  status          OrderStatus   @default(PENDING)
  paymentStatus   PaymentStatus @default(PENDING)
  paymentProvider String?
  customerId      String?       @db.Uuid
  email           String
  phone           String
  shippingAddress Json
  billingFields   Json?
  shippingMethod  String?
  shippingCents   Int           @default(0)
  subtotalCents   Int
  taxCents        Int
  totalCents      Int
  source          CartSource    @default(web)
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt
  tenant          Tenant        @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  customer        Customer?     @relation(fields: [customerId], references: [id])
  items           OrderItem[]
  events          OrderEvent[]
  payments        Payment[]

  @@unique([tenantId, number])
  @@index([tenantId, status])
}

model OrderItem {
  id                String  @id @default(uuid()) @db.Uuid
  tenantId          String  @db.Uuid
  orderId           String  @db.Uuid
  productId         String? @db.Uuid
  variantId         String? @db.Uuid
  nameSnapshot      String
  priceCentsSnapshot Int
  qty               Int
  taxRateSnapshot   TaxRate
  order             Order   @relation(fields: [orderId], references: [id], onDelete: Cascade)

  @@index([orderId])
}

model OrderEvent {
  id        String   @id @default(uuid()) @db.Uuid
  tenantId  String   @db.Uuid
  orderId   String   @db.Uuid
  type      String
  actor     String
  data      Json?
  createdAt DateTime @default(now())
  order     Order    @relation(fields: [orderId], references: [id], onDelete: Cascade)

  @@index([orderId])
}

model Payment {
  id          String  @id @default(uuid()) @db.Uuid
  tenantId    String  @db.Uuid
  orderId     String  @db.Uuid
  provider    String
  providerRef String?
  amountCents Int
  status      String
  raw         Json?
  createdAt   DateTime @default(now())
  order       Order   @relation(fields: [orderId], references: [id], onDelete: Cascade)

  @@index([orderId])
}

model WebhookEvent {
  id          String    @id @default(uuid()) @db.Uuid
  provider    String
  eventId     String
  tenantId    String?   @db.Uuid
  payload     Json
  processedAt DateTime?
  result      String?
  createdAt   DateTime  @default(now())

  @@unique([provider, eventId])
}

// ---- Agent ----
model Conversation {
  id         String              @id @default(uuid()) @db.Uuid
  tenantId   String              @db.Uuid
  channel    ConversationChannel
  shopperRef String?
  status     String              @default("open")
  startedAt  DateTime            @default(now())
  tenant     Tenant              @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  messages   Message[]

  @@index([tenantId, startedAt])
}

model Message {
  id             String       @id @default(uuid()) @db.Uuid
  tenantId       String       @db.Uuid
  conversationId String       @db.Uuid
  role           String
  content        String
  toolCalls      Json?
  inputTokens    Int          @default(0)
  outputTokens   Int          @default(0)
  createdAt      DateTime     @default(now())
  conversation   Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  @@index([conversationId])
}

model AgentUsage {
  id            String @id @default(uuid()) @db.Uuid
  tenantId      String @db.Uuid
  month         String // "2026-07"
  inputTokens   Int    @default(0)
  outputTokens  Int    @default(0)
  costCents     Int    @default(0)
  messagesCount Int    @default(0)

  @@unique([tenantId, month])
}

// ---- Content / Notifications / Platform ----
model TenantContent {
  id       String            @id @default(uuid()) @db.Uuid
  tenantId String            @db.Uuid
  type     TenantContentType
  title    String
  bodyMd   String            @default("")
  tenant   Tenant            @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, type])
}

model NotificationLog {
  id             String   @id @default(uuid()) @db.Uuid
  tenantId       String   @db.Uuid
  channel        String
  template       String
  recipient      String
  idempotencyKey String   @unique
  status         String
  attempts       Int      @default(0)
  createdAt      DateTime @default(now())
}

model Subscription {
  id         String    @id @default(uuid()) @db.Uuid
  tenantId   String    @db.Uuid
  plan       Plan
  priceCents Int
  paidUntil  DateTime?
  notes      String?
  tenant     Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId])
}

model AuditLog {
  id          String   @id @default(uuid()) @db.Uuid
  tenantId    String?  @db.Uuid
  actorUserId String?  @db.Uuid
  action      String
  entity      String
  entityId    String?
  data        Json?
  ip          String?
  createdAt   DateTime @default(now())

  @@index([tenantId, createdAt])
}

// ---- Phase-2 sockets (created, unused in v1) ----
model Shipment {
  id             String  @id @default(uuid()) @db.Uuid
  tenantId       String  @db.Uuid
  orderId        String  @db.Uuid
  provider       String?
  trackingNumber String?
  status         String?
  raw            Json?
}

model Invoice {
  id       String  @id @default(uuid()) @db.Uuid
  tenantId String  @db.Uuid
  orderId  String  @db.Uuid
  provider String?
  cufe     String?
  status   String?
  raw      Json?
}
```

`packages/db/src/index.ts` (extended in Task 6):
```ts
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
export * from '@prisma/client';
```

`packages/db/tsconfig.json`: same shape as core's (`outDir: dist`, `rootDir: src`, `include: ["src"]`).

- [ ] **Step 3: Generate migration against dev Postgres**

Run: `pnpm install && DATABASE_URL=postgresql://ventia:ventia@localhost:5432/ventia pnpm --filter @ventia/db exec prisma migrate dev --name init`
Expected: migration `prisma/migrations/<ts>_init/migration.sql` created and applied; `prisma generate` succeeds.

- [ ] **Step 4: Verify typecheck & commit**

Run: `pnpm --filter @ventia/db typecheck`
Expected: PASS.

```bash
git add packages/db && git commit -m "feat: add prisma schema v1 with full spec data model"
```

---

### Task 5: RLS migration + raw-SQL isolation tests

**Files:**
- Create: `packages/db/prisma/migrations/<ts>_rls/migration.sql` (via `prisma migrate dev --create-only`)
- Create: `packages/db/test/helpers.ts`, `packages/db/test/rls.test.ts`

**Interfaces:**
- Consumes: schema from Task 4.
- Produces: NOLOGIN role `ventia_app` (RLS-subject, granted to the connecting user); RLS enabled + `tenant_isolation` policy on every tenant-owned table; test helper `startTestDb(): Promise<{ url: string; stop: () => Promise<void> }>` that boots a `pgvector/pgvector:pg16` container and runs `prisma migrate deploy`.

RLS applies to these tables (tenant-owned): `Tenant` is **excluded** (it's the root; scoped client restricts by id), and so are auth tables (`User`, `Session`, `Account`, `Verification`, `Membership`), `WebhookEvent`, `AuditLog` (nullable tenant, system-written).

> **Superseded for `WebhookEvent` (P3 wave-3).** It is no longer RLS-excluded. Migration `20260815120000_webhook_event_tenant_read` grants `ventia_app` **SELECT only** and enables a `FOR SELECT` `tenant_isolation` policy, so merchants can read their own `paid_order_not_settleable` alerts (`/pagos-por-revisar`). Writes stay owner-only on `platformDb` — the exclusion still holds in full for `AuditLog` and for every write path here. The companion `WebhookEventReview` table (`20260815140000`) is tenant-owned but **append-only**: SELECT + INSERT granted, UPDATE/DELETE revoked, with `FOR SELECT` / `FOR INSERT` policies only. Included: `TenantDomain`, `TenantLimits`, `Category`, `Product`, `ProductCategory`, `ProductVariant`, `ProductImage`, `InventoryMovement`, `Cart`, `CartItem`, `Customer`, `Order`, `OrderItem`, `OrderEvent`, `Payment`, `Conversation`, `Message`, `AgentUsage`, `TenantContent`, `NotificationLog`, `Subscription`, `Shipment`, `Invoice`.

- [ ] **Step 1: Write failing RLS test**

`packages/db/test/helpers.ts`:
```ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'node:child_process';
import path from 'node:path';

export async function startTestDb(): Promise<{ url: string; container: StartedPostgreSqlContainer; stop: () => Promise<void> }> {
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  const url = container.getConnectionUri();
  execSync('npx prisma migrate deploy', {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
  return { url, container, stop: () => container.stop().then(() => undefined) };
}
```

`packages/db/test/rls.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { startTestDb } from './helpers';

const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await startTestDb();
  prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
  // seed two tenants + one product each (as table owner, bypasses RLS)
  for (const [id, slug] of [[T1, 't1'], [T2, 't2']] as const) {
    await prisma.tenant.create({ data: { id, slug, name: slug, status: 'live' } });
    await prisma.product.create({
      data: { tenantId: id, name: `p-${slug}`, slug: `p-${slug}`, priceCents: 1000 },
    });
  }
});

afterAll(async () => {
  await prisma.$disconnect();
  await db.stop();
});

async function asTenant<T>(tenantId: string, fn: (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ventia_app`);
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

describe('Postgres RLS', () => {
  it('tenant 1 context sees only tenant 1 products', async () => {
    const rows = await asTenant(T1, (tx) => tx.$queryRaw<{ tenantId: string }[]>`SELECT "tenantId" FROM "Product"`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenantId).toBe(T1);
  });

  it('cannot insert a row for another tenant', async () => {
    await expect(
      asTenant(T1, (tx) => tx.$executeRaw`
        INSERT INTO "Product" ("id", "tenantId", "name", "slug", "priceCents", "taxRate", "status", "updatedAt")
        VALUES (gen_random_uuid(), ${T2}::uuid, 'evil', 'evil', 1, '19', 'draft', now())
      `),
    ).rejects.toThrow(/row-level security/);
  });

  it('no GUC set means no rows visible', async () => {
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ventia_app`);
      return tx.$queryRaw<unknown[]>`SELECT 1 FROM "Product"`;
    });
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ventia/db test`
Expected: FAIL — role `ventia_app` does not exist / rows leak (no RLS yet).

- [ ] **Step 3: Create the RLS migration**

Run: `DATABASE_URL=postgresql://ventia:ventia@localhost:5432/ventia pnpm --filter @ventia/db exec prisma migrate dev --create-only --name rls`

Edit the generated `migration.sql` to exactly:
```sql
-- Extensions used across the platform
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "vector";

-- Non-owner role subject to RLS. NOLOGIN: reached via SET ROLE from the app connection.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ventia_app') THEN
    CREATE ROLE ventia_app NOLOGIN;
  END IF;
END $$;
GRANT ventia_app TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO ventia_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ventia_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ventia_app;

-- Enable RLS + tenant policy on tenant-owned tables
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'TenantDomain','TenantLimits','Category','Product','ProductCategory',
    'ProductVariant','ProductImage','InventoryMovement','Cart','CartItem',
    'Customer','Order','OrderItem','OrderEvent','Payment','Conversation',
    'Message','AgentUsage','TenantContent','NotificationLog','Subscription',
    'Shipment','Invoice'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK ("tenantId" = current_setting(''app.tenant_id'', true)::uuid)',
      t
    );
  END LOOP;
END $$;

-- Tenant root table: ventia_app may only read its own tenant row
ALTER TABLE "Tenant" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON "Tenant"
  USING ("id" = current_setting('app.tenant_id', true)::uuid);
```

Apply: `DATABASE_URL=postgresql://ventia:ventia@localhost:5432/ventia pnpm --filter @ventia/db exec prisma migrate dev`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ventia/db test`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/db && git commit -m "feat: enforce row-level security for tenant isolation"
```

---

### Task 6: Tenant-scoped Prisma client (`tenantDb` / `platformDb`)

**Files:**
- Create: `packages/db/src/tenant-client.ts`, `packages/db/src/tenant-models.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/test/tenant-client.test.ts`

**Interfaces:**
- Consumes: `ventia_app` role + policies (Task 5).
- Produces: `tenantDb(tenantId: string): TenantClient` — every operation runs in a transaction with `SET LOCAL ROLE ventia_app` + `app.tenant_id` GUC; creates get `tenantId` injected; list/aggregate ops get `where.tenantId` injected; a create/update naming a different `tenantId` throws `CrossTenantError`. `platformDb` — the unscoped base client (owner; bypasses RLS). `TENANT_MODELS: ReadonlySet<string>`.

- [ ] **Step 1: Write failing tests**

`packages/db/test/tenant-client.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { startTestDb } from './helpers';
import { createTenantDbFactory, CrossTenantError } from '../src/tenant-client';

const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';

let db: Awaited<ReturnType<typeof startTestDb>>;
let base: PrismaClient;
let tenantDb: ReturnType<typeof createTenantDbFactory>;

beforeAll(async () => {
  db = await startTestDb();
  base = new PrismaClient({ datasources: { db: { url: db.url } } });
  tenantDb = createTenantDbFactory(base);
  for (const [id, slug] of [[T1, 't1'], [T2, 't2']] as const) {
    await base.tenant.create({ data: { id, slug, name: slug, status: 'live' } });
    await base.product.create({ data: { tenantId: id, name: slug, slug, priceCents: 1000 } });
  }
});

afterAll(async () => {
  await base.$disconnect();
  await db.stop();
});

describe('tenantDb', () => {
  it('findMany returns only own-tenant rows without an explicit where', async () => {
    const products = await tenantDb(T1).product.findMany();
    expect(products.map((p) => p.tenantId)).toEqual([T1]);
  });

  it('cannot read another tenant row even with an explicit filter', async () => {
    const other = await tenantDb(T1).product.findFirst({ where: { tenantId: T2 } });
    expect(other).toBeNull();
  });

  it('create injects tenantId', async () => {
    const p = await tenantDb(T1).product.create({
      data: { name: 'nuevo', slug: 'nuevo', priceCents: 500 },
    });
    expect(p.tenantId).toBe(T1);
  });

  it('create naming another tenantId throws CrossTenantError', async () => {
    await expect(
      tenantDb(T1).product.create({
        data: { tenantId: T2, name: 'evil', slug: 'evil', priceCents: 1 },
      }),
    ).rejects.toThrow(CrossTenantError);
  });

  it('updateMany cannot touch another tenant rows', async () => {
    const res = await tenantDb(T1).product.updateMany({ data: { priceCents: 9 } });
    expect(res.count).toBeGreaterThan(0);
    const t2 = await base.product.findFirstOrThrow({ where: { tenantId: T2 } });
    expect(t2.priceCents).toBe(1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ventia/db test -- tenant-client`
Expected: FAIL — `../src/tenant-client` not found.

- [ ] **Step 3: Implement**

`packages/db/src/tenant-models.ts`:
```ts
// Prisma model names that carry a tenantId column (kept in sync with schema.prisma;
// the RLS migration list is the source of truth for the database layer).
export const TENANT_MODELS: ReadonlySet<string> = new Set([
  'TenantDomain', 'TenantLimits', 'Category', 'Product', 'ProductCategory',
  'ProductVariant', 'ProductImage', 'InventoryMovement', 'Cart', 'CartItem',
  'Customer', 'Order', 'OrderItem', 'OrderEvent', 'Payment', 'Conversation',
  'Message', 'AgentUsage', 'TenantContent', 'NotificationLog', 'Subscription',
  'Shipment', 'Invoice',
]);
```

`packages/db/src/tenant-client.ts`:
```ts
import { Prisma, PrismaClient } from '@prisma/client';
import { TENANT_MODELS } from './tenant-models';

export class CrossTenantError extends Error {
  constructor(model: string) {
    super(`Cross-tenant write rejected on ${model}`);
    this.name = 'CrossTenantError';
  }
}

type AnyArgs = Record<string, unknown> & { where?: Record<string, unknown>; data?: unknown };

function scopeArgs(model: string, operation: string, args: AnyArgs, tenantId: string): AnyArgs {
  const next: AnyArgs = { ...args };
  const guardData = (data: unknown): unknown => {
    if (Array.isArray(data)) return data.map(guardData);
    if (data && typeof data === 'object') {
      const d = { ...(data as Record<string, unknown>) };
      if ('tenantId' in d && d.tenantId !== tenantId) throw new CrossTenantError(model);
      d.tenantId = tenantId;
      return d;
    }
    return data;
  };
  if (operation === 'create' || operation === 'createMany' || operation === 'upsert') {
    if ('data' in next) next.data = guardData(next.data);
    if ('create' in next) next.create = guardData(next.create);
  }
  if (operation === 'update' || operation === 'updateMany') {
    const d = next.data as Record<string, unknown> | undefined;
    if (d && 'tenantId' in d && d.tenantId !== tenantId) throw new CrossTenantError(model);
  }
  next.where = { AND: [{ tenantId }, (args.where ?? {}) as object] };
  // findUnique-style ops require the unique where untouched; RLS still filters them.
  if (operation === 'findUnique' || operation === 'findUniqueOrThrow' || operation === 'delete' || operation === 'update' || operation === 'upsert') {
    next.where = args.where;
  }
  return next;
}

export function createTenantDbFactory(base: PrismaClient) {
  return function tenantDb(tenantId: string) {
    if (!tenantId) throw new Error('tenantDb requires a tenantId');
    return base.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            const scoped = TENANT_MODELS.has(model)
              ? scopeArgs(model, operation, args as AnyArgs, tenantId)
              : args;
            const [, , result] = await base.$transaction([
              base.$executeRawUnsafe('SET LOCAL ROLE ventia_app'),
              base.$executeRaw(
                Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
              ),
              query(scoped),
            ]);
            return result;
          },
        },
      },
    });
  };
}

export type TenantClient = ReturnType<ReturnType<typeof createTenantDbFactory>>;
```

`packages/db/src/index.ts` becomes:
```ts
import { PrismaClient } from '@prisma/client';
import { createTenantDbFactory } from './tenant-client';

/** Unscoped client. Owner connection — bypasses RLS. Platform-admin/system use only. */
export const platformDb = new PrismaClient();

/** Tenant-scoped client: RLS GUC + role per transaction, tenantId injection. */
export const tenantDb = createTenantDbFactory(platformDb);

export { CrossTenantError, createTenantDbFactory } from './tenant-client';
export type { TenantClient } from './tenant-client';
export { TENANT_MODELS } from './tenant-models';
export * from '@prisma/client';
```

Note: if `query(scoped)` cannot be composed into `base.$transaction([...])` in the installed Prisma 6 version (this batch-composition is the documented Prisma RLS pattern — verify against the Prisma docs "Row-level security" extension example at implementation time), fall back to `base.$transaction(async (tx) => { await tx.$executeRawUnsafe(...); await tx.$executeRaw(...); return (tx as any)[modelAccessor][operation](scoped); })` where `modelAccessor` is `model[0].toLowerCase() + model.slice(1)`. The tests define the contract either way.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ventia/db test`
Expected: PASS (rls + tenant-client suites).

- [ ] **Step 5: Commit**

```bash
git add packages/db && git commit -m "feat: add tenant-scoped prisma client with cross-tenant write guard"
```

---

### Task 7: services/api — NestJS skeleton + health endpoint

**Files:**
- Create: `services/api/package.json`, `services/api/tsconfig.json`, `services/api/vitest.config.ts`, `services/api/src/main.ts`, `services/api/src/app.module.ts`, `services/api/src/health/health.controller.ts`
- Test: `services/api/test/health.test.ts`

**Interfaces:**
- Consumes: `loadEnv` from `@ventia/core`.
- Produces: Nest app factory `createApp(): Promise<INestApplication>` (used by tests and `main.ts`); `GET /v1/health` → `{ status: 'ok' }`.

- [ ] **Step 1: Write failing test**

`services/api/test/health.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';

let app: INestApplication;
beforeAll(async () => {
  app = await createApp();
  await app.init();
});
afterAll(async () =>Await app.close());

describe('GET /v1/health', () => {
  it('returns ok', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
```
(Fix the typo when writing: `afterAll(async () => { await app.close(); });`)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ventia/api test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`services/api/package.json`:
```json
{
  "name": "@ventia/api",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src test",
    "test": "vitest run",
    "dev": "tsx watch src/main.ts"
  },
  "dependencies": {
    "@nestjs/common": "^10.4.0",
    "@nestjs/core": "^10.4.0",
    "@nestjs/platform-express": "^10.4.0",
    "@ventia/core": "workspace:*",
    "@ventia/db": "workspace:*",
    "better-auth": "^1.1.0",
    "express": "^4.21.0",
    "ioredis": "^5.4.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.0"
  },
  "devDependencies": {
    "@testcontainers/postgresql": "^10.13.0",
    "supertest": "^7.0.0",
    "@types/supertest": "^6.0.0",
    "@types/express": "^4.17.0",
    "testcontainers": "^10.13.0",
    "tsx": "^4.19.0",
    "vitest": "^2.1.0"
  }
}
```

`services/api/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true
  },
  "include": ["src"]
}
```

`services/api/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', hookTimeout: 120_000, testTimeout: 60_000 },
});
```

`services/api/src/health/health.controller.ts`:
```ts
import { Controller, Get } from '@nestjs/common';

@Controller('v1/health')
export class HealthController {
  @Get()
  health() {
    return { status: 'ok' };
  }
}
```

`services/api/src/app.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';

@Module({ controllers: [HealthController] })
export class AppModule {}
```

`services/api/src/main.ts`:
```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';

export async function createApp(): Promise<INestApplication> {
  return NestFactory.create(AppModule, { logger: ['error', 'warn'] });
}

if (require.main === module) {
  void (async () => {
    const { loadEnv } = await import('@ventia/core');
    const env = loadEnv();
    const app = await createApp();
    await app.listen(env.API_PORT);
  })();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm --filter @ventia/api test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/api && git commit -m "feat: add nestjs api skeleton with health endpoint"
```

---

### Task 8: Tenant resolution — Redis-cached resolver + middleware + `GET /v1/tenant`

**Files:**
- Create: `services/api/src/tenants/domain-resolver.ts`, `services/api/src/tenants/tenant.middleware.ts`, `services/api/src/tenants/tenant.controller.ts`
- Modify: `services/api/src/app.module.ts`
- Test: `services/api/test/domain-resolver.test.ts`, `services/api/test/tenant-endpoint.test.ts`

**Interfaces:**
- Consumes: `platformDb` from `@ventia/db`.
- Produces:
  - `normalizeHost(host: string | undefined): string | null` — lowercases, strips port.
  - `class DomainResolver { constructor(redis: Redis, db: PrismaClient, ttlSeconds = 60); resolve(host: string): Promise<ResolvedTenant | null> }` with `ResolvedTenant = { tenantId: string; slug: string; name: string; status: 'draft' | 'live' | 'suspended' }`; caches JSON in Redis key `tenant:domain:{host}` (60 s TTL), caches misses as `"null"`.
  - `TenantMiddleware` attaches `req.tenant: ResolvedTenant | null`.
  - `GET /v1/tenant` → 200 `{ tenantId, slug, name, status }` or 404 `{ error: 'TENANT_NOT_FOUND' }`.

- [ ] **Step 1: Write failing resolver test**

`services/api/test/domain-resolver.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import Redis from 'ioredis';
import { PrismaClient } from '@ventia/db';
import { startTestDb } from '@ventia/db/test/helpers';
import { DomainResolver, normalizeHost } from '../src/tenants/domain-resolver';

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let redis: Redis;
let prisma: PrismaClient;
let resolver: DomainResolver;

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  redis = new Redis({ host: redisContainer.getHost(), port: redisContainer.getMappedPort(6379) });
  prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
  const tenant = await prisma.tenant.create({ data: { slug: 'demo', name: 'Demo', status: 'live' } });
  await prisma.tenantDomain.create({ data: { tenantId: tenant.id, domain: 'demo.ventia.localhost', isPrimary: true } });
  resolver = new DomainResolver(redis, prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  redis.disconnect();
  await redisContainer.stop();
  await db.stop();
});

describe('normalizeHost', () => {
  it('strips port and lowercases', () => {
    expect(normalizeHost('Demo.Ventia.localhost:3000')).toBe('demo.ventia.localhost');
  });
  it('returns null for undefined', () => {
    expect(normalizeHost(undefined)).toBeNull();
  });
});

describe('DomainResolver', () => {
  it('resolves a known domain', async () => {
    const t = await resolver.resolve('demo.ventia.localhost');
    expect(t?.slug).toBe('demo');
    expect(t?.status).toBe('live');
  });

  it('returns null for unknown domain and caches the miss', async () => {
    expect(await resolver.resolve('nope.ventia.localhost')).toBeNull();
    expect(await redis.get('tenant:domain:nope.ventia.localhost')).toBe('null');
  });

  it('serves from cache after first hit (db row deleted, still resolves)', async () => {
    await resolver.resolve('demo.ventia.localhost');
    await prisma.tenantDomain.deleteMany({ where: { domain: 'demo.ventia.localhost' } });
    const t = await resolver.resolve('demo.ventia.localhost');
    expect(t?.slug).toBe('demo');
  });
});
```

Note: importing `@ventia/db/test/helpers` requires adding to `packages/db/package.json`:
```json
"exports": { ".": "./dist/index.js", "./test/helpers": "./test/helpers.ts" }
```
(plus keep `"main"`/`"types"`). If export-map friction with vitest arises, copy `startTestDb` into `services/api/test/helpers.ts` instead — duplication of a 15-line test helper is acceptable.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ventia/api test -- domain-resolver`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement resolver + middleware + controller**

`services/api/src/tenants/domain-resolver.ts`:
```ts
import type Redis from 'ioredis';
import type { PrismaClient } from '@ventia/db';

export interface ResolvedTenant {
  tenantId: string;
  slug: string;
  name: string;
  status: 'draft' | 'live' | 'suspended';
}

export function normalizeHost(host: string | undefined): string | null {
  if (!host) return null;
  return host.split(':')[0]!.trim().toLowerCase() || null;
}

export class DomainResolver {
  constructor(
    private readonly redis: Redis,
    private readonly db: PrismaClient,
    private readonly ttlSeconds = 60,
  ) {}

  async resolve(host: string): Promise<ResolvedTenant | null> {
    const key = `tenant:domain:${host}`;
    const cached = await this.redis.get(key);
    if (cached !== null) return cached === 'null' ? null : (JSON.parse(cached) as ResolvedTenant);

    const row = await this.db.tenantDomain.findUnique({
      where: { domain: host },
      include: { tenant: true },
    });
    const resolved: ResolvedTenant | null = row
      ? { tenantId: row.tenantId, slug: row.tenant.slug, name: row.tenant.name, status: row.tenant.status }
      : null;
    await this.redis.set(key, resolved ? JSON.stringify(resolved) : 'null', 'EX', this.ttlSeconds);
    return resolved;
  }
}
```

`services/api/src/tenants/tenant.middleware.ts`:
```ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { DomainResolver, normalizeHost, type ResolvedTenant } from './domain-resolver';

declare module 'express-serve-static-core' {
  interface Request {
    tenant?: ResolvedTenant | null;
  }
}

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly resolver: DomainResolver) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    const host = normalizeHost(req.headers.host);
    req.tenant = host ? await this.resolver.resolve(host) : null;
    next();
  }
}
```

`services/api/src/tenants/tenant.controller.ts`:
```ts
import { Controller, Get, NotFoundException, Req } from '@nestjs/common';
import type { Request } from 'express';

@Controller('v1/tenant')
export class TenantController {
  @Get()
  current(@Req() req: Request) {
    if (!req.tenant) throw new NotFoundException({ error: 'TENANT_NOT_FOUND' });
    return req.tenant;
  }
}
```

`services/api/src/app.module.ts` becomes:
```ts
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import Redis from 'ioredis';
import { platformDb } from '@ventia/db';
import { HealthController } from './health/health.controller';
import { DomainResolver } from './tenants/domain-resolver';
import { TenantMiddleware } from './tenants/tenant.middleware';
import { TenantController } from './tenants/tenant.controller';

@Module({
  controllers: [HealthController, TenantController],
  providers: [
    {
      provide: DomainResolver,
      useFactory: () => new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379'),
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
```
Correction while implementing: the provider above must build the resolver, not the Redis client:
```ts
{
  provide: DomainResolver,
  useFactory: () =>
    new DomainResolver(new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379'), platformDb),
}
```

- [ ] **Step 4: Write failing endpoint test**

`services/api/test/tenant-endpoint.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
// Same container setup as domain-resolver.test.ts: startTestDb + redis container.
// Set process.env.DATABASE_URL and process.env.REDIS_URL BEFORE importing createApp,
// then dynamic-import: const { createApp } = await import('../src/main');

let app: INestApplication;
// beforeAll: start containers, seed tenant 'demo' with domain 'demo.ventia.localhost',
// set env vars, createApp(), app.init().

describe('GET /v1/tenant', () => {
  it('resolves by Host header', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/tenant')
      .set('Host', 'demo.ventia.localhost');
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe('demo');
  });

  it('404s for unknown host', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/tenant')
      .set('Host', 'unknown.ventia.localhost');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('TENANT_NOT_FOUND');
  });
});
```
Fill in the beforeAll/afterAll following `domain-resolver.test.ts` exactly (same containers, same seeding, plus `process.env.DATABASE_URL = db.url; process.env.REDIS_URL = ...` before the dynamic import). `platformDb` reads `DATABASE_URL` at construction, hence the dynamic import.

- [ ] **Step 5: Run all api tests**

Run: `pnpm --filter @ventia/api test`
Expected: PASS (health, resolver, endpoint).

- [ ] **Step 6: Commit**

```bash
git add services/api packages/db && git commit -m "feat: resolve tenants by host with redis cache"
```

---

### Task 9: better-auth + session context

**Files:**
- Create: `services/api/src/auth/auth.ts`, `services/api/src/auth/session-context.ts`
- Modify: `services/api/src/main.ts`
- Test: `services/api/test/auth.test.ts`

**Interfaces:**
- Consumes: `platformDb`; User/Session/Account/Verification/Membership models (Task 4).
- Produces:
  - `createAuth(db: PrismaClient, opts: { secret: string; baseURL: string }): ReturnType<typeof betterAuth>` — email+password enabled.
  - `getSessionContext(auth, db, headers: Headers): Promise<SessionContext | null>` with `SessionContext = { userId: string; email: string; tenantId: string | null; role: 'owner' | 'staff' | 'platform_admin' | null }` (membership resolved via `Membership`; first membership wins in P0).
  - Auth HTTP routes mounted at `/v1/auth/*` via `toNodeHandler`.

- [ ] **Step 1: Write failing test**

`services/api/test/auth.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@ventia/db';
import { startTestDb } from './helpers';
import { createAuth } from '../src/auth/auth';
import { getSessionContext } from '../src/auth/session-context';

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClient;
let auth: ReturnType<typeof createAuth>;

beforeAll(async () => {
  db = await startTestDb();
  prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
  auth = createAuth(prisma, { secret: 'test-secret', baseURL: 'http://api.ventia.localhost' });
});

afterAll(async () => {
  await prisma.$disconnect();
  await db.stop();
});

describe('auth', () => {
  it('signs up and signs in with email/password', async () => {
    const signUp = await auth.api.signUpEmail({
      body: { email: 'owner@demo.co', password: 'Secret123!', name: 'Owner' },
    });
    expect(signUp.user.email).toBe('owner@demo.co');

    const signIn = await auth.api.signInEmail({
      body: { email: 'owner@demo.co', password: 'Secret123!' },
      returnHeaders: true,
    });
    expect(signIn.headers.get('set-cookie')).toBeTruthy();
  });

  it('getSessionContext returns membership tenant and role', async () => {
    const tenant = await prisma.tenant.create({ data: { slug: 'ctx', name: 'Ctx', status: 'live' } });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'owner@demo.co' } });
    await prisma.membership.create({ data: { userId: user.id, tenantId: tenant.id, role: 'owner' } });

    const signIn = await auth.api.signInEmail({
      body: { email: 'owner@demo.co', password: 'Secret123!' },
      returnHeaders: true,
    });
    const cookie = signIn.headers.get('set-cookie')!;
    const ctx = await getSessionContext(auth, prisma, new Headers({ cookie }));
    expect(ctx).toMatchObject({ email: 'owner@demo.co', tenantId: tenant.id, role: 'owner' });
  });

  it('returns null without a session', async () => {
    expect(await getSessionContext(auth, prisma, new Headers())).toBeNull();
  });
});
```
(`services/api/test/helpers.ts`: copy of `startTestDb` from `packages/db/test/helpers.ts` if the cross-package import was not set up in Task 8.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ventia/api test -- auth`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`services/api/src/auth/auth.ts`:
```ts
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import type { PrismaClient } from '@ventia/db';

export function createAuth(db: PrismaClient, opts: { secret: string; baseURL: string }) {
  return betterAuth({
    database: prismaAdapter(db, { provider: 'postgresql' }),
    secret: opts.secret,
    baseURL: opts.baseURL,
    basePath: '/v1/auth',
    emailAndPassword: {
      enabled: true,
      // Email verification is wired (sender logs in dev) but not required to sign in in P0.
      // M1 (P1) enforces verification before a store can launch.
      requireEmailVerification: false,
    },
    advanced: { database: { generateId: false } }, // let Prisma uuid() defaults generate ids
  });
}
```
Note: better-auth expects specific model/field names; the Task 4 schema matches its Prisma adapter defaults (`user`, `session`, `account`, `verification` accessors). If `pnpm --filter @ventia/api test` reports missing fields, run `npx @better-auth/cli generate` to diff the expected schema against ours, add any missing columns via `prisma migrate dev --name auth_fields`, and re-run. Read the better-auth docs during implementation — do not guess API names.

`services/api/src/auth/session-context.ts`:
```ts
import type { PrismaClient } from '@ventia/db';
import type { createAuth } from './auth';

export interface SessionContext {
  userId: string;
  email: string;
  tenantId: string | null;
  role: 'owner' | 'staff' | 'platform_admin' | null;
}

export async function getSessionContext(
  auth: ReturnType<typeof createAuth>,
  db: PrismaClient,
  headers: Headers,
): Promise<SessionContext | null> {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  const membership = await db.membership.findFirst({ where: { userId: session.user.id } });
  return {
    userId: session.user.id,
    email: session.user.email,
    tenantId: membership?.tenantId ?? null,
    role: membership?.role ?? null,
  };
}
```

Mount in `services/api/src/main.ts` (replace `createApp`):
```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import { platformDb } from '@ventia/db';
import { AppModule } from './app.module';
import { createAuth } from './auth/auth';

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'], bodyParser: false });
  const auth = createAuth(platformDb, {
    secret: process.env.AUTH_SECRET ?? 'dev-secret-change-me',
    baseURL: process.env.API_URL ?? 'http://api.ventia.localhost',
  });
  const httpAdapter = app.getHttpAdapter().getInstance() as express.Express;
  httpAdapter.all('/v1/auth/*', toNodeHandler(auth));
  httpAdapter.use(express.json());
  return app;
}

if (require.main === module) {
  void (async () => {
    const { loadEnv } = await import('@ventia/core');
    const env = loadEnv();
    const app = await createApp();
    await app.listen(env.API_PORT);
  })();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ventia/api test`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add services/api packages/db && git commit -m "feat: wire better-auth with membership session context"
```

---

### Task 10: Next.js apps — storefront (tenant-aware) + admin placeholder

**Files:**
- Create: `apps/storefront/package.json`, `apps/storefront/tsconfig.json`, `apps/storefront/next.config.ts`, `apps/storefront/app/layout.tsx`, `apps/storefront/app/page.tsx`, `apps/storefront/lib/tenant.ts`, `apps/storefront/vitest.config.ts`
- Test: `apps/storefront/test/tenant.test.ts`
- Create: `apps/admin/package.json`, `apps/admin/tsconfig.json`, `apps/admin/next.config.ts`, `apps/admin/app/layout.tsx`, `apps/admin/app/page.tsx`

**Interfaces:**
- Consumes: `GET /v1/tenant` (Task 8).
- Produces: `fetchTenantForHost(host: string | null, apiUrl: string, fetchImpl?: typeof fetch): Promise<ResolvedTenant | null>` in `apps/storefront/lib/tenant.ts`; storefront root page renders tenant home (store name, es-CO copy) or platform landing; admin renders a placeholder page on :3001.

- [ ] **Step 1: Write failing test for the fetch helper**

`apps/storefront/test/tenant.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { fetchTenantForHost } from '../lib/tenant';

describe('fetchTenantForHost', () => {
  it('returns tenant on 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tenantId: 't', slug: 'demo', name: 'Demo', status: 'live' }), { status: 200 }),
    );
    const t = await fetchTenantForHost('demo.ventia.localhost', 'http://api', fetchImpl);
    expect(t?.name).toBe('Demo');
    expect(fetchImpl).toHaveBeenCalledWith('http://api/v1/tenant', {
      headers: { Host: 'demo.ventia.localhost' },
      cache: 'no-store',
    });
  });

  it('returns null on 404 or null host', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }));
    expect(await fetchTenantForHost('x.local', 'http://api', fetchImpl)).toBeNull();
    expect(await fetchTenantForHost(null, 'http://api', fetchImpl)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ventia/storefront test`
Expected: FAIL — `../lib/tenant` not found.

- [ ] **Step 3: Implement storefront**

`apps/storefront/package.json`:
```json
{
  "name": "@ventia/storefront",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3000",
    "build": "next build",
    "typecheck": "tsc --noEmit",
    "lint": "eslint app lib test",
    "test": "vitest run"
  },
  "dependencies": { "next": "^15.0.0", "react": "^19.0.0", "react-dom": "^19.0.0" },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@types/node": "^22.0.0",
    "vitest": "^2.1.0"
  }
}
```

`apps/storefront/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "preserve",
    "noEmit": true,
    "lib": ["dom", "dom.iterable", "esnext"],
    "plugins": [{ "name": "next" }]
  },
  "include": ["app", "lib", "next-env.d.ts"]
}
```

`apps/storefront/next.config.ts`:
```ts
import type { NextConfig } from 'next';
const nextConfig: NextConfig = {};
export default nextConfig;
```

`apps/storefront/lib/tenant.ts`:
```ts
export interface ResolvedTenant {
  tenantId: string;
  slug: string;
  name: string;
  status: 'draft' | 'live' | 'suspended';
}

export async function fetchTenantForHost(
  host: string | null,
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedTenant | null> {
  if (!host) return null;
  const res = await fetchImpl(`${apiUrl}/v1/tenant`, {
    headers: { Host: host },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return (await res.json()) as ResolvedTenant;
}
```

`apps/storefront/app/layout.tsx`:
```tsx
export const metadata = { title: 'Ventia' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-CO">
      <body>{children}</body>
    </html>
  );
}
```

`apps/storefront/app/page.tsx`:
```tsx
import { headers } from 'next/headers';
import { fetchTenantForHost } from '../lib/tenant';

export default async function Home() {
  const host = (await headers()).get('host');
  const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
  const tenant = await fetchTenantForHost(host, apiUrl);

  if (!tenant) {
    return (
      <main>
        <h1>Ventia</h1>
        <p>Tu tienda con vendedor de IA. Próximamente.</p>
      </main>
    );
  }
  return (
    <main>
      <h1>{tenant.name}</h1>
      <p>Bienvenido a la tienda de {tenant.name}.</p>
    </main>
  );
}
```
(`API_INTERNAL_URL` points at the API directly — server-side fetch must not loop through Caddy with a spoofed Host of itself. Add `API_INTERNAL_URL=http://localhost:4000` to `.env.example`.)

`apps/storefront/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node' } });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm --filter @ventia/storefront test`
Expected: PASS.

- [ ] **Step 5: Create admin placeholder**

`apps/admin/package.json`: same as storefront's with name `@ventia/admin`, `"dev": "next dev -p 3001"`, no vitest/test script. `apps/admin/tsconfig.json`, `next.config.ts`: same as storefront's. `apps/admin/app/layout.tsx`: same as storefront's with title `'Ventia Admin'`.

`apps/admin/app/page.tsx`:
```tsx
export default function AdminHome() {
  return (
    <main>
      <h1>Ventia Admin</h1>
      <p>Panel de administración. Disponible en la fase P1.</p>
    </main>
  );
}
```

- [ ] **Step 6: Verify builds & commit**

Run: `pnpm build && pnpm typecheck`
Expected: both Next apps build.

```bash
git add apps && git commit -m "feat: add tenant-aware storefront and admin placeholder"
```

---

### Task 11: Seed script + end-to-end subdomain verification

**Files:**
- Create: `packages/db/src/seed.ts`
- Modify: `packages/db/package.json` (add `"seed": "tsx src/seed.ts"` script and `tsx` devDependency)

**Interfaces:**
- Consumes: `platformDb`.
- Produces: idempotent seed creating tenants `demo-moda` and `demo-tech` (status `live`, plan `basico`, limits from `PLANS.basico`) with domains `demo-moda.ventia.localhost` / `demo-tech.ventia.localhost` and 2 products each.

- [ ] **Step 1: Write the seed**

`packages/db/src/seed.ts`:
```ts
import { PLANS } from '@ventia/core';
import { platformDb } from './index';

const TENANTS = [
  { slug: 'demo-moda', name: 'Demo Moda', products: [
    { name: 'Camiseta básica', slug: 'camiseta-basica', priceCents: 4590000 / 100 },
    { name: 'Jean clásico', slug: 'jean-clasico', priceCents: 12990000 / 100 },
  ]},
  { slug: 'demo-tech', name: 'Demo Tech', products: [
    { name: 'Audífonos inalámbricos', slug: 'audifonos-inalambricos', priceCents: 18990000 / 100 },
    { name: 'Cargador rápido 30W', slug: 'cargador-rapido-30w', priceCents: 5990000 / 100 },
  ]},
];

async function main() {
  for (const t of TENANTS) {
    const tenant = await platformDb.tenant.upsert({
      where: { slug: t.slug },
      update: { status: 'live' },
      create: { slug: t.slug, name: t.name, status: 'live', plan: 'basico' },
    });
    await platformDb.tenantDomain.upsert({
      where: { domain: `${t.slug}.ventia.localhost` },
      update: {},
      create: { tenantId: tenant.id, domain: `${t.slug}.ventia.localhost`, isPrimary: true, verifiedAt: new Date() },
    });
    await platformDb.tenantLimits.upsert({
      where: { tenantId: tenant.id },
      update: {},
      create: { tenantId: tenant.id, ...PLANS.basico },
    });
    for (const p of t.products) {
      await platformDb.product.upsert({
        where: { tenantId_slug: { tenantId: tenant.id, slug: p.slug } },
        update: {},
        create: { tenantId: tenant.id, name: p.name, slug: p.slug, priceCents: Math.round(p.priceCents), stock: 10, status: 'active' },
      });
    }
  }
  console.log('Seed complete');
}

main().finally(() => platformDb.$disconnect());
```
Note the money values: `4590000 / 100` = 45 900 COP in cents… that is wrong by design review — write literals directly as integer cents: `4590000` cents = $45.900 COP. Use plain integers (`priceCents: 4590000`) — remove the `/ 100`.

- [ ] **Step 2: Run seed twice (idempotency)**

Run (dev stack up, migrations applied):
```bash
DATABASE_URL=postgresql://ventia:ventia@localhost:5432/ventia pnpm --filter @ventia/db seed
DATABASE_URL=postgresql://ventia:ventia@localhost:5432/ventia pnpm --filter @ventia/db seed
```
Expected: "Seed complete" twice, no unique-violation errors.

- [ ] **Step 3: End-to-end DoD verification**

With `docker compose -f docker/compose.yaml up -d`, API (`pnpm --filter @ventia/api dev`) and storefront (`pnpm --filter @ventia/storefront dev`) running:

```bash
curl -s -H "Host: demo-moda.ventia.localhost" http://localhost:4000/v1/tenant   # {"tenantId":...,"slug":"demo-moda",...}
curl -s -H "Host: unknown.ventia.localhost" http://localhost:4000/v1/tenant     # 404 TENANT_NOT_FOUND
curl -s http://demo-moda.ventia.localhost/ | grep "Demo Moda"                   # through Caddy → storefront
curl -s http://demo-tech.ventia.localhost/ | grep "Demo Tech"
curl -s http://ventia.localhost/ | grep "Ventia"                                # platform landing
```
Expected: all five succeed.

- [ ] **Step 4: Commit**

```bash
git add packages/db .env.example && git commit -m "feat: seed two demo tenants with domains and products"
```

---

### Task 12: CI + README + DoD checklist

**Files:**
- Create: `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Consumes: all package scripts.
- Produces: CI running lint, typecheck, build, test on push/PR; README quickstart.

- [ ] **Step 1: Create workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @ventia/db generate
      - run: pnpm turbo run lint typecheck build
      - run: pnpm turbo run test
```
(Testcontainers uses the runner's Docker daemon — available by default on `ubuntu-latest`.)

- [ ] **Step 2: Write README**

`README.md` — quickstart (in English): prerequisites (Node 22, pnpm 9 via corepack, Docker), `cp .env.example .env`, `docker compose -f docker/compose.yaml up -d`, `pnpm install`, `pnpm --filter @ventia/db migrate:dev`, seed, run api/storefront/admin dev servers, the five curl checks from Task 11, and a "Phase status" section (P0 ✅ … P6 ⬜). Note any pnpm version deviation here.

- [ ] **Step 3: Full local CI parity check**

Run: `pnpm turbo run lint typecheck build && pnpm turbo run test`
Expected: everything green — this is the P0 DoD gate (isolation tests included).

- [ ] **Step 4: Commit & push**

```bash
git add .github README.md && git commit -m "ci: add lint/typecheck/build/test workflow and quickstart"
git push -u origin claude/nueva-plataforma-superpowers-o3r31f
```

---

## Self-Review Notes

- **Spec coverage (P0 scope §11):** monorepo scaffold (T1), compose dev env minus Chatwoot per approved design (T2), Prisma schema v1 + migrations (T4), RLS harness + scoped client (T5–T6), better-auth (T9), tenant resolution middleware (T8, T10), CI (T12), seeded tenants resolving by subdomain (T11). DoD items all have executable checks.
- **Known judgment calls recorded:** Prisma default naming instead of snake_case (§ Global Constraints); Tenant root table gets a read-own policy instead of the generic tenantId policy; auth/webhook/audit tables excluded from RLS (system-scoped, accessed via platformDb only).
- **Library-API uncertainty is flagged inline** (better-auth adapter field expectations, Prisma `$transaction` batch composition with extensions) with a verification instruction and a fallback — read the official docs at implementation time rather than trusting this plan's memory of them.
