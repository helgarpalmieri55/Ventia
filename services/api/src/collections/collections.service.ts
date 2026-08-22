import { HttpException, Injectable } from '@nestjs/common';
import { Prisma, platformDb, tenantDb } from '@ventia/db';
import {
  COLLECTION_MAX_PRODUCTS,
  collectionInputSchema,
  collectionProductsAddSchema,
  collectionProductsSetSchema,
  collectionUpdateSchema,
  slugify,
} from '@ventia/core';
import type { AdminSessionContext } from '../admin/roles.decorator';
import { parseOr400 } from '../catalog/parse';
import { writeAudit } from '../catalog/audit';
import { revalidateStorefrontTag } from '../storefront/revalidate';

/** Same `base`, `base-2`, … `base-20` ladder `ProductsService.uniqueSlug`
 * walks. Kept identical so a merchant who names a collection after a product
 * ("Vestido Lino") gets the same behaviour they already know from the product
 * form, rather than a second dedupe convention in the same admin. */
const MAX_SLUG_SUFFIX = 20;

function isUniqueConstraintError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function isNotFoundError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

/**
 * One collection, as the admin sees it. Hand-written rather than inferred from
 * the Prisma payload for the same reason `ProductDTO` is (TS2742: an inferred
 * type that cannot be named without reaching into the generated client's
 * runtime types).
 */
export interface CollectionDTO {
  id: string;
  name: string;
  slug: string;
  descriptionMd: string;
  position: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** Every membership row, whatever the product's status. */
  productCount: number;
  /**
   * How many of those a shopper can actually reach today.
   *
   * Both numbers are returned, and the difference between them is the whole
   * point: a merchant whose "Ofertas" row vanished from the storefront needs
   * to see "8 productos, 0 disponibles" rather than a strip that is simply
   * gone. The storefront applies exactly this filter (see
   * `storefront-collections.controller.ts`), so these two fields are what let
   * the admin explain the storefront instead of guessing at it.
   */
  activeProductCount: number;
}

/** A membership row in the admin's curation list: the product's own fields
 * plus the position the merchant put it in. `status` rides along because the
 * admin deliberately shows archived and draft members (the storefront hides
 * them) — a member the shopper cannot see is exactly the row the merchant
 * came here to remove. */
export interface CollectionProductDTO {
  productId: string;
  position: number;
  name: string;
  slug: string;
  status: 'draft' | 'active' | 'archived';
  priceCents: number;
  thumbnailUrl: string | null;
}

export interface CollectionDetailDTO extends CollectionDTO {
  products: CollectionProductDTO[];
}

@Injectable()
export class CollectionsService {
  async list(session: AdminSessionContext): Promise<CollectionDTO[]> {
    const db = tenantDb(session.tenantId);

    // Three cheap queries instead of one `include: { products: true }`: the
    // list only needs two numbers per collection, and including the rows
    // would drag up to COLLECTION_MAX_PRODUCTS membership rows per collection
    // across the wire to be thrown away after `.length`. Filtered relation
    // counts (`_count: { select: { products: { where: ... } } }`) would do it
    // in one, but they are still behind Prisma's `filteredRelationCount`
    // preview flag, which this schema does not enable.
    const [collections, totals, actives] = await Promise.all([
      db.collection.findMany({ orderBy: [{ position: 'asc' }, { name: 'asc' }] }),
      db.collectionProduct.groupBy({ by: ['collectionId'], _count: { productId: true } }),
      db.collectionProduct.groupBy({
        by: ['collectionId'],
        where: { product: { status: 'active' } },
        _count: { productId: true },
      }),
    ]);

    const totalBy = new Map(totals.map((row) => [row.collectionId, row._count.productId]));
    const activeBy = new Map(actives.map((row) => [row.collectionId, row._count.productId]));

    return collections.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      descriptionMd: c.descriptionMd,
      position: c.position,
      isActive: c.isActive,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      productCount: totalBy.get(c.id) ?? 0,
      activeProductCount: activeBy.get(c.id) ?? 0,
    }));
  }

  async detail(session: AdminSessionContext, id: string): Promise<CollectionDetailDTO> {
    const collection = await tenantDb(session.tenantId).collection.findFirst({
      where: { id },
      include: {
        products: {
          // The merchant's order, and a deterministic tiebreak. `position`
          // ties are ordinary — every row a merchant never dragged sits where
          // it was appended, and rows added in the same batch can share a
          // position after a removal — and without the second key the same
          // list can come back in two different orders on two reloads, which
          // reads as the admin losing the merchant's arrangement.
          orderBy: [{ position: 'asc' }, { product: { name: 'asc' } }],
          include: { product: { include: { images: { orderBy: { position: 'asc' }, take: 1 } } } },
        },
      },
    });
    if (!collection) throw new HttpException({ error: 'NOT_FOUND' }, 404);

    const products: CollectionProductDTO[] = collection.products.map((row) => ({
      productId: row.productId,
      position: row.position,
      name: row.product.name,
      slug: row.product.slug,
      status: row.product.status,
      priceCents: row.product.priceCents,
      thumbnailUrl: row.product.images[0]?.url ?? null,
    }));

    return {
      id: collection.id,
      name: collection.name,
      slug: collection.slug,
      descriptionMd: collection.descriptionMd,
      position: collection.position,
      isActive: collection.isActive,
      createdAt: collection.createdAt,
      updatedAt: collection.updatedAt,
      productCount: products.length,
      activeProductCount: products.filter((p) => p.status === 'active').length,
      products,
    };
  }

  async create(session: AdminSessionContext, body: unknown): Promise<CollectionDetailDTO> {
    const input = parseOr400(collectionInputSchema, body);
    const tenantId = session.tenantId;
    const db = tenantDb(tenantId);

    // An explicitly supplied slug is deduped exactly like a derived one, and
    // NOT rejected — matching `ProductsService.create` (categories, which 409
    // instead, are the odd one out). At create time the merchant has not
    // published anything yet, so silently landing on `ofertas-2` costs them
    // nothing; refusing would cost them a form round trip for a URL they
    // probably did not type deliberately. Update is where an explicit slug
    // becomes a precise, refusable request — see `update()`.
    const derived = input.slug ?? slugify(input.name);
    // `slugify` strips everything that is not `[a-z0-9]`, so a name made
    // entirely of punctuation or of a script it does not transliterate ("✨",
    // "特価") comes back as the empty string. Left alone, that publishes a
    // collection whose storefront URL has no last segment — the first one
    // takes `''` and the unique index makes every later one a mystery 409.
    // Asking for a nameable name is the only repair, and it belongs here
    // rather than in the schema, which cannot see what `slugify` will make of
    // a name it accepted.
    if (derived.length === 0) {
      throw new HttpException(
        { error: 'VALIDATION_FAILED', details: { name: 'usa al menos una letra o un número' } },
        400,
      );
    }
    const slug = await this.uniqueSlug(tenantId, derived);

    // Appended, not prepended, when the merchant did not say where it goes. A
    // new collection defaulting to `position: 0` (the column's own default)
    // would push itself above every strip the merchant already arranged — so
    // building next month's sale would silently demote this month's, on the
    // live storefront, before a single product is in it.
    const last = await db.collection.findFirst({ orderBy: { position: 'desc' }, select: { position: true } });
    const position = input.position ?? (last ? last.position + 1 : 0);

    try {
      const collection = await db.collection.create({
        data: {
          tenantId,
          name: input.name,
          slug,
          descriptionMd: input.descriptionMd,
          position,
          isActive: input.isActive ?? true,
        },
      });
      await writeAudit(session, 'collection.create', 'Collection', collection.id, input);
      revalidateStorefrontTag(`collections:${tenantId}`);
      return this.detail(session, collection.id);
    } catch (err) {
      // `uniqueSlug` above read, then this wrote — two concurrent creates of
      // the same name both see the slug free and one of them loses here.
      if (isUniqueConstraintError(err)) throw new HttpException({ error: 'SLUG_TAKEN' }, 409);
      throw err;
    }
  }

  /**
   * PATCH. The one rule worth stating out loud: **renaming never moves the
   * collection**.
   *
   * `slug` is only ever changed when the caller sends one. A rename that
   * re-derived the slug would break every link that already points at the old
   * one — the storefront's own strips, a WhatsApp broadcast the merchant sent
   * last week, whatever Google has indexed — and this repo has no redirect
   * table to catch them (nor may this task add one). So a slug change is an
   * explicit, deliberate act, and the admin warns before making it.
   *
   * For the same reason an explicit slug is NOT deduped here the way create
   * dedupes: a merchant who typed `ofertas` meant `ofertas`, and quietly
   * publishing them at `ofertas-2` would hand them a URL they never saw. A
   * collision is a 409 they can act on.
   */
  async update(session: AdminSessionContext, id: string, body: unknown): Promise<CollectionDetailDTO> {
    const input = parseOr400(collectionUpdateSchema, body);
    try {
      const collection = await tenantDb(session.tenantId).collection.update({ where: { id }, data: input });
      await writeAudit(session, 'collection.update', 'Collection', collection.id, input);
      revalidateStorefrontTag(`collections:${session.tenantId}`);
      return this.detail(session, collection.id);
    } catch (err) {
      if (isNotFoundError(err)) throw new HttpException({ error: 'NOT_FOUND' }, 404);
      throw err;
    }
  }

  async remove(session: AdminSessionContext, id: string): Promise<void> {
    try {
      await tenantDb(session.tenantId).collection.delete({ where: { id } });
    } catch (err) {
      if (isNotFoundError(err)) throw new HttpException({ error: 'NOT_FOUND' }, 404);
      throw err;
    }
    // Only the `CollectionProduct` join rows go with it (`onDelete: Cascade`
    // on that relation in schema.prisma) — the products themselves are
    // untouched, same as deleting a category.
    await writeAudit(session, 'collection.delete', 'Collection', id);
    revalidateStorefrontTag(`collections:${session.tenantId}`);
  }

  /**
   * Replaces the membership AND the order in one atomic write — the operation
   * that makes reordering a real request instead of N of them.
   *
   * Positions are the array indices, so the response's order is exactly the
   * array the caller sent. Nothing is preserved from the previous membership:
   * a product that was in the collection and is not in the array is removed,
   * which is what lets one "guardar orden" button also handle the row the
   * merchant just deleted from the list in front of them.
   */
  async setProducts(session: AdminSessionContext, id: string, body: unknown): Promise<CollectionDetailDTO> {
    const input = parseOr400(collectionProductsSetSchema, body);
    const tenantId = session.tenantId;

    await this.assertCollectionExists(tenantId, id);
    await this.assertProductsExist(tenantId, input.productIds);

    // Manual RLS transaction escape, the same one `variants.controller.ts`
    // uses and for the same reason: `tenantDb` opens a fresh transaction per
    // call, so it cannot span "drop the old membership, write the new one" as
    // one unit — and a half-applied reorder is a storefront strip in an order
    // nobody chose. `tenantDb()` is never called from inside this callback:
    // it would ask the pool for a second connection while this one is held,
    // which is the deadlock this repo has already had in production.
    await platformDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

      await tx.collectionProduct.deleteMany({ where: { collectionId: id, tenantId } });
      if (input.productIds.length) {
        await tx.collectionProduct.createMany({
          data: input.productIds.map((productId, index) => ({
            tenantId,
            collectionId: id,
            productId,
            position: index,
          })),
        });
      }
    });

    await writeAudit(session, 'collection.products_set', 'Collection', id, input);
    revalidateStorefrontTag(`collections:${tenantId}`);
    return this.detail(session, id);
  }

  /**
   * Appends products to the end, leaving everything already there exactly
   * where it is.
   *
   * Ids already in the collection are skipped rather than moved or rejected:
   * the admin's picker cannot know for certain what a colleague added while
   * it was open, and re-sending one is not an error the merchant can act on.
   * Skipping (instead of re-appending) is also what keeps the merchant's
   * existing arrangement intact — the alternative silently drags an old row
   * to the bottom of the strip.
   */
  async addProducts(session: AdminSessionContext, id: string, body: unknown): Promise<CollectionDetailDTO> {
    const input = parseOr400(collectionProductsAddSchema, body);
    const tenantId = session.tenantId;

    await this.assertCollectionExists(tenantId, id);
    await this.assertProductsExist(tenantId, input.productIds);

    // Read and write inside ONE transaction (same manual-RLS escape as
    // `setProducts`): "what is already here, and what is the last position"
    // decides what gets written, so reading it on a separate connection would
    // let two staff members adding at once compute the same next position —
    // or, worse, both insert the same productId and hit the composite primary
    // key as a 500.
    await platformDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

      const existing = await tx.collectionProduct.findMany({
        where: { collectionId: id, tenantId },
        select: { productId: true, position: true },
      });
      const alreadyIn = new Set(existing.map((row) => row.productId));
      const toAdd = input.productIds.filter((productId) => !alreadyIn.has(productId));
      if (toAdd.length === 0) return;

      if (existing.length + toAdd.length > COLLECTION_MAX_PRODUCTS) {
        // Thrown inside the callback so Prisma rolls back: an append that
        // would breach the cap adds nothing at all, rather than the prefix
        // that happened to fit.
        throw new HttpException(
          { error: 'VALIDATION_FAILED', details: { productIds: `máximo ${COLLECTION_MAX_PRODUCTS} productos` } },
          400,
        );
      }

      // `-1 + 1 = 0` for an empty collection, which is where the first row
      // belongs. Positions may already have gaps (removals do not renumber),
      // so this is max+1 rather than count.
      const nextPosition = existing.reduce((max, row) => Math.max(max, row.position), -1) + 1;
      await tx.collectionProduct.createMany({
        data: toAdd.map((productId, index) => ({
          tenantId,
          collectionId: id,
          productId,
          position: nextPosition + index,
        })),
      });
    });

    await writeAudit(session, 'collection.products_add', 'Collection', id, input);
    revalidateStorefrontTag(`collections:${tenantId}`);
    return this.detail(session, id);
  }

  /**
   * Removes one product from one collection.
   *
   * Idempotent: a product that is not a member is already in the state the
   * caller asked for, so this answers 204 rather than 404 — the merchant who
   * double-clicked "Quitar", and the stale tab, both get the right answer.
   * The 404 is reserved for the collection itself not existing, which IS
   * something the caller needs to know about.
   *
   * The surviving rows are NOT renumbered. Positions only ever decide an
   * ordering, and `0, 1, 3` orders identically to `0, 1, 2` — renumbering
   * would be a write per row for no observable difference.
   */
  async removeProduct(session: AdminSessionContext, id: string, productId: string): Promise<void> {
    const tenantId = session.tenantId;
    await this.assertCollectionExists(tenantId, id);
    await tenantDb(tenantId).collectionProduct.deleteMany({ where: { collectionId: id, productId } });
    await writeAudit(session, 'collection.product_remove', 'Collection', id, { productId });
    revalidateStorefrontTag(`collections:${tenantId}`);
  }

  private async assertCollectionExists(tenantId: string, id: string): Promise<void> {
    const collection = await tenantDb(tenantId).collection.findFirst({ where: { id }, select: { id: true } });
    if (!collection) throw new HttpException({ error: 'NOT_FOUND' }, 404);
  }

  /**
   * Tenant-scoped existence check before any membership write.
   *
   * Not redundant with the foreign key: Postgres does not apply row-level
   * security to foreign-key checks, so a `productId` copied from another
   * store would satisfy the constraint and link two tenants' catalogs
   * together. Reading it back through `tenantDb` is what turns a foreign id
   * into an ordinary validation error. (Same reasoning as
   * `CategoriesController.assertParentAllowed` and `ProductsService`'s
   * `categoryIds` check.)
   *
   * Draft and archived products are deliberately allowed in: a merchant
   * assembling next month's sale curates products before publishing them, and
   * the storefront filter (not this one) is what keeps an unbuyable product
   * out of a shopper's view.
   */
  private async assertProductsExist(tenantId: string, productIds: string[]): Promise<void> {
    if (productIds.length === 0) return;
    const found = await tenantDb(tenantId).product.count({ where: { id: { in: productIds } } });
    // The schema already rejects duplicates, so a count mismatch can only
    // mean an id this tenant does not own.
    if (found !== productIds.length) {
      throw new HttpException({ error: 'VALIDATION_FAILED', details: { productIds: 'producto inexistente' } }, 400);
    }
  }

  private async uniqueSlug(tenantId: string, base: string): Promise<string> {
    const db = tenantDb(tenantId);
    for (let suffix = 1; suffix <= MAX_SLUG_SUFFIX; suffix++) {
      const candidate = suffix === 1 ? base : `${base}-${suffix}`;
      const clash = await db.collection.findFirst({ where: { slug: candidate }, select: { id: true } });
      if (!clash) return candidate;
    }
    throw new HttpException({ error: 'SLUG_TAKEN' }, 409);
  }
}
