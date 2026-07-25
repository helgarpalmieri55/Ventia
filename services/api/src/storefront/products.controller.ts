import { Controller, Get, HttpException, Inject, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { PublicTenantGuard } from './public-tenant.guard';
import { StorefrontTenantId } from './storefront-tenant.decorator';
import { StorefrontProductsService } from './products.service';

/** Parses a query param as a finite, non-negative number, throwing the same
 * VALIDATION_FAILED shape as `parseOr400` (catalog/parse.ts) on failure.
 * `Number(undefined)` is NaN and `raw` is only ever a string or undefined
 * here (query params), so this alone is enough to reject `?page=abc` etc.
 * before the value ever reaches the SQL LIMIT/OFFSET/price comparison.
 *
 * `requireInteger` additionally rejects fractional values (e.g. `?page=1.5`)
 * — needed for `page`/`pageSize`, which flow straight into
 * `products.service.ts`'s `(page - 1) * pageSize` SQL `OFFSET` and would
 * otherwise silently produce a fractional offset. `priceMax` is deliberately
 * left fractional-friendly: it's compared against the integer `priceCents`
 * column with `<=` (`products.service.ts`), where a fractional value (e.g. a
 * peso amount) is a perfectly meaningful filter, not malformed input. */
function parseNonNegativeNumberOr400(
  raw: string | undefined,
  field: string,
  options: { requireInteger?: boolean } = {},
): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (options.requireInteger && !Number.isInteger(value))) {
    throw new HttpException({ error: 'VALIDATION_FAILED', details: { [field]: 'debe ser un número válido' } }, 400);
  }
  return value;
}

@Controller('v1/storefront/products')
@UseGuards(PublicTenantGuard)
export class StorefrontProductsController {
  // Explicit @Inject (matching catalog/products.controller.ts,
  // catalog/variants.controller.ts): under vitest's transform, Nest's
  // implicit constructor-param DI (which relies on `design:paramtypes`
  // reflect-metadata) does not reliably resolve, silently leaving the
  // property undefined instead of throwing at bootstrap — explicit token
  // injection sidesteps that.
  constructor(@Inject(StorefrontProductsService) private readonly products: StorefrontProductsService) {}

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
      priceMax: parseNonNegativeNumberOr400(priceMax, 'priceMax'),
      sort: sort === 'price' || sort === 'newest' ? sort : 'relevance',
      page: parseNonNegativeNumberOr400(page, 'page', { requireInteger: true }),
      pageSize: parseNonNegativeNumberOr400(pageSize, 'pageSize', { requireInteger: true }),
    });
  }

  // Route order note: `GET /v1/storefront/products` (this controller's base
  // path, zero extra segments) and `GET /v1/storefront/products/:slug` (one
  // extra segment) never collide, so `list` above doesn't need to be
  // declared after `detail` — Nest dispatches purely on segment count/shape
  // here, not registration order.
  @Get(':slug')
  async detail(@StorefrontTenantId() tenantId: string, @Param('slug') slug: string) {
    const detail = await this.products.detail(tenantId, slug);
    if (!detail) throw new NotFoundException({ error: 'PRODUCT_NOT_FOUND' });
    return detail;
  }
}
