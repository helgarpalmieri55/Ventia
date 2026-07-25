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
