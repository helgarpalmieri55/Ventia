import { HttpException, Injectable } from '@nestjs/common';
import { Prisma, tenantDb } from '@ventia/db';

/**
 * A shopper's wishlist, at one store.
 *
 * Same per-shopper rule as `ShopperAddressesService`: RLS isolates by tenant,
 * so `accountId` in every `where` is what keeps one shopper out of another's
 * list. Less sensitive than a home address, and still nobody's business.
 */

/** A bound rather than a product limit, for the same reason the address cap
 * exists: an unbounded per-account list is a way for one account to become
 * unbounded storage. Set far above what a person actually saves. */
export const MAX_WISHLIST_ITEMS = 200;

export interface WishlistEntry {
  productId: string;
  name: string;
  slug: string;
  priceCents: number;
  imageUrl: string | null;
  /** Whether it can still be bought. A wishlisted product that the merchant
   * archived stays IN the list and is marked unavailable rather than
   * disappearing: the shopper put it there deliberately, and a list that
   * silently loses entries reads as data loss, not as a sold-out sign. */
  available: boolean;
  addedAt: Date;
}

@Injectable()
export class ShopperWishlistService {
  async list(tenantId: string, accountId: string): Promise<WishlistEntry[]> {
    const rows = await tenantDb(tenantId).wishlistItem.findMany({
      where: { tenantId, accountId },
      orderBy: { createdAt: 'desc' },
      include: {
        product: {
          include: { images: { orderBy: { position: 'asc' }, take: 1 } },
        },
      },
    });

    return rows.map((row) => ({
      productId: row.productId,
      name: row.product.name,
      slug: row.product.slug,
      priceCents: row.product.priceCents,
      imageUrl: row.product.images[0]?.url ?? null,
      available: row.product.status === 'active',
      addedAt: row.createdAt,
    }));
  }

  /**
   * Adds one. Idempotent: saving a product twice is a shopper double-tapping a
   * heart, not an error, and answering 409 would make the UI have to explain
   * something nobody did wrong.
   */
  async add(tenantId: string, accountId: string, productId: string): Promise<void> {
    const db = tenantDb(tenantId);

    // The product must exist IN THIS STORE. Without this check a productId
    // from another tenant would be refused by the foreign key anyway — but as
    // a 500, and foreign keys are not subject to RLS, so the failure would be
    // a database error rather than the honest 404.
    const product = await db.product.findFirst({ where: { id: productId, tenantId }, select: { id: true } });
    if (!product) throw new HttpException({ error: 'PRODUCT_NOT_FOUND' }, 404);

    const count = await db.wishlistItem.count({ where: { tenantId, accountId } });
    if (count >= MAX_WISHLIST_ITEMS) throw new HttpException({ error: 'WISHLIST_FULL' }, 409);

    try {
      await db.wishlistItem.create({ data: { tenantId, accountId, productId } });
    } catch (error) {
      // Already saved. The unique constraint is doing exactly its job, and a
      // check-then-insert would race two taps against each other anyway.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
      throw error;
    }
  }

  /** Removes one. Also idempotent — the desired state is "not saved", and it
   * has been reached either way. */
  async remove(tenantId: string, accountId: string, productId: string): Promise<void> {
    await tenantDb(tenantId).wishlistItem.deleteMany({ where: { tenantId, accountId, productId } });
  }

  /** Whether this shopper saved this product — for the heart on a product
   * page, which has to render filled or empty on first paint. */
  async has(tenantId: string, accountId: string, productId: string): Promise<boolean> {
    const row = await tenantDb(tenantId).wishlistItem.findFirst({
      where: { tenantId, accountId, productId },
      select: { productId: true },
    });
    return row !== null;
  }
}
