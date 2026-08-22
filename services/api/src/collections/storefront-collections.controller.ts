import { Controller, Get, UseGuards } from '@nestjs/common';
import { tenantDb } from '@ventia/db';
import { PublicTenantGuard } from '../storefront/public-tenant.guard';
import { StorefrontTenantId } from '../storefront/storefront-tenant.decorator';

/**
 * How many products one strip carries.
 *
 * A curated row is a shop window, not a catalog page: it scrolls sideways and
 * a shopper on a phone sees two or three tiles at a time. Twelve is generous
 * for that and it is also the payload bound — the home page fetches EVERY
 * active collection in one request, so without a cap a store with eight
 * collections of two hundred products each would ship sixteen hundred product
 * records to render a handful of tiles.
 *
 * Deliberately not a query parameter. There is exactly one consumer (the home
 * page's strips), and a caller-tunable limit is a promise to keep it working
 * at any value the day someone asks for 200.
 */
const STRIP_PRODUCT_LIMIT = 12;

interface StorefrontCollectionProduct {
  id: string;
  name: string;
  slug: string;
  priceCents: number;
  compareAtCents: number | null;
  thumbnailUrl: string | null;
  inStock: boolean;
}

interface StorefrontCollection {
  id: string;
  name: string;
  slug: string;
  products: StorefrontCollectionProduct[];
}

/**
 * `GET /v1/storefront/collections` — the shop's curated rows ("Nuevos",
 * "Ofertas": docs/design-gap.md §3).
 *
 * Guard and shape follow `storefront/categories.controller.ts`: same
 * `PublicTenantGuard` (a draft tenant is indistinguishable from a missing
 * one; a suspended tenant is a 503), same "project exactly what the
 * storefront renders" rule.
 *
 * ## Three filters, and the shopper each one protects
 *
 * 1. **`isActive` collections only.** A hidden collection keeps its products
 *    on purpose (see the schema comment) — it is where next month's sale is
 *    assembled. It must not be reachable from the shop while it is being
 *    built.
 *
 * 2. **`active` products only.** A product is soft-deleted by archiving it
 *    (`ProductsService.archive` sets `status: 'archived'`), and the
 *    membership row survives that — nothing in the schema cascades on a
 *    status change, and nothing should: un-archiving a product must put it
 *    back in the strips it was curated into, which is impossible if archiving
 *    threw the curation away. So the filter lives here, on the read. A
 *    genuinely DELETED product needs no filter at all: `CollectionProduct`
 *    cascades on the product's deletion. Either way a shopper never sees a
 *    strip advertising something they cannot buy. `draft` products are
 *    excluded by the same clause, which is what lets a merchant curate a
 *    product before publishing it.
 *
 * 3. **Collections with nothing left to show are omitted entirely.** Not
 *    returned as an empty strip: a heading over blank space reads as a broken
 *    page, and the two ways to get one are both ordinary — a collection
 *    created a minute ago and not filled yet, and one whose whole contents
 *    were archived when the sale ended. This mirrors `pruneEmptyCategories`
 *    in the storefront's own navigation, which drops categories that lead
 *    nowhere for the same reason. The merchant is not left guessing why:
 *    `GET /v1/admin/collections` returns `productCount` next to
 *    `activeProductCount` precisely so the admin can say "8 productos, 0
 *    disponibles".
 *
 * `descriptionMd` is deliberately absent from this response. Nothing in the
 * storefront has anywhere to render it — the strip is a heading and a row of
 * tiles — and shipping a field no page reads invites a future caller to build
 * on a shape that was never designed. It comes back the day there is a
 * collection page with room for it.
 */
@Controller('v1/storefront/collections')
@UseGuards(PublicTenantGuard)
export class StorefrontCollectionsController {
  @Get()
  async list(@StorefrontTenantId() tenantId: string): Promise<StorefrontCollection[]> {
    const collections = await tenantDb(tenantId).collection.findMany({
      where: { isActive: true },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
      include: {
        products: {
          where: { product: { status: 'active' } },
          // The merchant's order (`position`), then the product name so two
          // rows sharing a position cannot swap places between two page
          // loads. `take` applies AFTER the filter, so an archived product
          // does not consume one of the twelve slots.
          orderBy: [{ position: 'asc' }, { product: { name: 'asc' } }],
          take: STRIP_PRODUCT_LIMIT,
          include: { product: { include: { images: { orderBy: { position: 'asc' }, take: 1 } } } },
        },
      },
    });

    return collections
      .map((collection) => ({
        id: collection.id,
        name: collection.name,
        slug: collection.slug,
        products: collection.products.map((row) => ({
          id: row.product.id,
          name: row.product.name,
          slug: row.product.slug,
          priceCents: row.product.priceCents,
          compareAtCents: row.product.compareAtCents,
          thumbnailUrl: row.product.images[0]?.url ?? null,
          // Same rule as `StorefrontProductsService`: an untracked product is
          // always buyable. Out-of-stock products stay in the strip rather
          // than being filtered out, exactly as they stay in the category
          // grid — the storefront's answer to "sold out" is a label on the
          // tile, and having two different answers in two places is how a
          // shopper ends up seeing a product on the home page and not on its
          // own category.
          inStock: !row.product.trackInventory || row.product.stock > 0,
        })),
      }))
      .filter((collection) => collection.products.length > 0);
  }
}
