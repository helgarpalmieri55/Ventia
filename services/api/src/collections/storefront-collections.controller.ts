import { Controller, Get, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { COLLECTION_MAX_PRODUCTS } from '@ventia/core';
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

/**
 * How many products the collection PAGE carries.
 *
 * `COLLECTION_MAX_PRODUCTS` rather than a number of its own, because that is
 * the ceiling the admin already enforces on a membership
 * (`collectionProductsSetSchema` / `CollectionsService.addProducts`): at this
 * value the `take` can never truncate a collection a merchant was allowed to
 * build, so the page always shows the whole shop window. It is a bound, not a
 * page size — there is no pager here and there does not need to be one, since
 * a collection is a hand-curated row and 200 is the most one can ever hold.
 *
 * Kept as a `take` anyway rather than omitted: an unbounded relation read is
 * one schema change away from being the query that ships a whole catalog to a
 * phone.
 */
const DETAIL_PRODUCT_LIMIT = COLLECTION_MAX_PRODUCTS;

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
 * One collection, as its own page renders it: the list's shape plus the
 * paragraph the merchant wrote.
 *
 * `descriptionMd` lives here and NOT on the list (see the controller comment)
 * because this is the response with somewhere to put it. The name is kept —
 * `Md` — even though the storefront renders it as plain text today: the column
 * is markdown, the admin's field says so, and a response that renamed it would
 * be promising the storefront something the merchant's input does not
 * guarantee.
 */
interface StorefrontCollectionDetail extends StorefrontCollection {
  descriptionMd: string;
}

/** The membership row shape both handlers project from. Hand-written rather
 * than inferred from the Prisma payload, matching `CollectionDTO` in
 * `collections.service.ts` (TS2742). */
interface CuratedProductRow {
  product: {
    id: string;
    name: string;
    slug: string;
    priceCents: number;
    compareAtCents: number | null;
    trackInventory: boolean;
    stock: number;
    images: Array<{ url: string }>;
  };
}

/**
 * One tile, from one membership row — shared by the strip and the page so the
 * two can never disagree about a product.
 *
 * That is not a tidiness point. A shopper meets the same product twice, once
 * in a strip on the home page and once on the collection page the strip links
 * to; a price or an `inStock` computed two ways is a store that contradicts
 * itself between two clicks.
 */
function toCuratedProduct(row: CuratedProductRow): StorefrontCollectionProduct {
  return {
    id: row.product.id,
    name: row.product.name,
    slug: row.product.slug,
    priceCents: row.product.priceCents,
    compareAtCents: row.product.compareAtCents,
    thumbnailUrl: row.product.images[0]?.url ?? null,
    // Same rule as `StorefrontProductsService`: an untracked product is
    // always buyable. Out-of-stock products stay in the strip rather than
    // being filtered out, exactly as they stay in the category grid — the
    // storefront's answer to "sold out" is a label on the tile, and having
    // two different answers in two places is how a shopper ends up seeing a
    // product on the home page and not on its own category.
    inStock: !row.product.trackInventory || row.product.stock > 0,
  };
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
 * `descriptionMd` is deliberately absent from the LIST response. Nothing on
 * the home page has anywhere to render it — a strip is a heading and a row of
 * tiles — and shipping a field no page reads invites a future caller to build
 * on a shape that was never designed. `GET :slug` below is the response with
 * room for it, and it is the only one that carries it.
 *
 * ## `GET :slug` — the collection's own page
 *
 * Same three filters, with one deliberate difference: an active collection
 * with nothing buyable left in it answers **200 with an empty `products`**,
 * where the list omits it entirely. Both rules protect the same shopper from
 * the same thing (a heading over blank space) and they differ because the two
 * responses have different room to explain themselves. On the home page there
 * is none — a strip either says something or should not be there. On the
 * collection's own page there is: the page can say "esta colección no tiene
 * productos disponibles" and point back to the shop, which is a better answer
 * than a 404 for the shopper who followed the merchant's own WhatsApp link
 * the week after the sale ended. A 404 would tell them they mistyped
 * something.
 *
 * A collection the merchant has HIDDEN still 404s, exactly as it is still
 * omitted from the list. `isActive: false` is where next month's sale is
 * assembled, and "exists but is not for you yet" and "does not exist" have to
 * be the same answer or the URL becomes a preview channel.
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
        products: collection.products.map(toCuratedProduct),
      }))
      .filter((collection) => collection.products.length > 0);
  }

  /**
   * `GET /v1/storefront/collections/:slug` — one collection, everything in it.
   *
   * No collision with `@Get()` above: Nest dispatches on segment count here,
   * so declaration order does not matter (same note as
   * `storefront/products.controller.ts`).
   *
   * `findFirst`, not `findUnique`: the slug is unique PER TENANT
   * (`@@unique([tenantId, slug])`), and `tenantDb` injects the tenant filter —
   * which `findUnique` cannot accept alongside a partial compound key.
   */
  @Get(':slug')
  async detail(
    @StorefrontTenantId() tenantId: string,
    @Param('slug') slug: string,
  ): Promise<StorefrontCollectionDetail> {
    const collection = await tenantDb(tenantId).collection.findFirst({
      where: { slug, isActive: true },
      include: {
        products: {
          where: { product: { status: 'active' } },
          orderBy: [{ position: 'asc' }, { product: { name: 'asc' } }],
          take: DETAIL_PRODUCT_LIMIT,
          include: { product: { include: { images: { orderBy: { position: 'asc' }, take: 1 } } } },
        },
      },
    });
    // `COLLECTION_NOT_FOUND`, not a bare 404 body: the storefront's fetch
    // helper only distinguishes 404 from "temporarily broken" by status, but
    // the code is what makes a log line readable when a merchant reports a
    // dead link.
    if (!collection) throw new NotFoundException({ error: 'COLLECTION_NOT_FOUND' });

    return {
      id: collection.id,
      name: collection.name,
      slug: collection.slug,
      descriptionMd: collection.descriptionMd,
      products: collection.products.map(toCuratedProduct),
    };
  }
}
