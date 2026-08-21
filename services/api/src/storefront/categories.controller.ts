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
    // `parentId` is projected rather than the shape being nested here: the
    // storefront needs the same flat list for a breadcrumb (walk up from one
    // category) and for a drop-down menu (group by parent), and a tree built
    // server-side is only convenient for the second. The list is a store's
    // whole category set — tens of rows — so the client can assemble either.
    return categories.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      parentId: c.parentId,
      productCount: c.products.length,
    }));
  }
}
