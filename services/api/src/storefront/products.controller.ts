import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { PublicTenantGuard } from './public-tenant.guard';
import { StorefrontTenantId } from './storefront-tenant.decorator';
import { StorefrontProductsService } from './products.service';

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
      priceMax: priceMax ? Number(priceMax) : undefined,
      sort: sort === 'price' || sort === 'newest' ? sort : 'relevance',
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }
}
