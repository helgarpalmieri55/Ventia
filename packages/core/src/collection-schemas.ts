import { z } from 'zod';

/**
 * Contract for `/v1/admin/collections` and `/v1/storefront/collections`.
 *
 * A collection is CURATION and a category is TAXONOMY — the distinction
 * `Collection`'s own doc comment in `packages/db/prisma/schema.prisma` draws,
 * and the reason this file exists at all instead of collections reusing
 * `categoryInputSchema`. Two consequences show up right here:
 *
 *  - There is no `parentId`. Categories nest because taxonomy nests ("Mujer ›
 *    Ropa › Vestidos"); "Ofertas" is not a child of anything and putting it
 *    under one is exactly the mistake the schema comment warns about.
 *  - Membership carries an ORDER (see {@link collectionProductsSetSchema}).
 *    Category membership is a set — a product is in "Ropa" or it isn't — while
 *    a collection is a sequence the merchant arranged, and the API has to be
 *    able to express "these products, in THIS order" as one request.
 */

/**
 * The most products one collection may hold.
 *
 * Not a database constraint, and not arbitrary: `PUT /:id/products` rewrites
 * the whole membership in a single transaction from a client-supplied array,
 * so this is the bound on how much work one request can ask for. It is also
 * far more than a curated row can usefully show — the storefront strip renders
 * a dozen — so a merchant who hits it is building a category, not a
 * collection, and the 400 telling them so is a better answer than a 30-second
 * write.
 */
export const COLLECTION_MAX_PRODUCTS = 200;

/**
 * A collection's slug, as it appears in a storefront URL.
 *
 * Stricter than `categoryInputSchema.slug` (which accepts any non-empty
 * string) on purpose. A slug typed by hand in the admin — "Ropa de Verano" —
 * would round-trip through the API unchanged and produce a link no shopper can
 * share and no CDN can cache consistently: the space becomes `%20`, the
 * capitals survive in the path but not in most copy-paste paths. Rejecting it
 * at the edge means the merchant fixes it while they are looking at the form,
 * rather than discovering it from a broken WhatsApp link a week later.
 *
 * Deliberately NOT applied to a name-derived slug: `slugify()` already emits
 * this shape, so the only input this can reject is one a human typed.
 */
export const collectionSlugSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'usa solo minúsculas, números y guiones');

export const collectionInputSchema = z.object({
  name: z.string().min(1).max(80),
  /** Omitted means "derive it from the name" — see the controller, which also
   * decides what happens when the derived slug is already taken. */
  slug: collectionSlugSchema.optional(),
  descriptionMd: z.string().max(20_000).default(''),
  /** Where this collection sits among the storefront's strips. Omitted on
   * create means "last", not "first" — the API appends. */
  position: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

/**
 * PATCH body. Every field optional, and `slug` means something different here
 * than on create: on create an absent slug is derived from the name, while on
 * update an absent slug leaves the live URL alone. Renaming a collection
 * therefore never moves it — see the controller for why that is not a
 * convenience but a correctness rule.
 */
export const collectionUpdateSchema = collectionInputSchema.partial();

/**
 * Rejects an id that appears twice in a membership payload.
 *
 * `CollectionProduct`'s primary key is `(collectionId, productId)`, so a
 * repeated id is a unique-constraint violation the moment it reaches Postgres
 * — reported as an opaque 409 that says nothing about which id was doubled.
 * More importantly, this is an ORDERED list: silently deduping it (the way
 * `ProductsService.create` dedupes `categoryIds`, where order is meaningless)
 * would quietly answer a different question than the client asked, and the
 * merchant would see a row in an order they did not choose. A duplicate here
 * is a client bug, and a 400 naming the field is the honest reply.
 */
const uniqueProductIds = (ids: string[]): boolean => new Set(ids).size === ids.length;

/**
 * `PUT /v1/admin/collections/:id/products` — the whole membership AND its
 * order, as one array, replacing whatever was there.
 *
 * This is the endpoint that makes reordering first-class. The alternative a
 * client would otherwise be forced into — one PATCH per row to nudge
 * `position` — is N round trips for one merchant gesture, and it has no
 * atomic state: a browser that loses connectivity halfway leaves the strip
 * half-reordered, with duplicate positions and a shopper-visible order nobody
 * chose. One array, one transaction, one order.
 *
 * An empty array is valid and means "empty this collection" — a merchant
 * whose sale ended needs that, and it is not the same request as deleting the
 * collection (which throws away the name, the slug every link points at, and
 * the description).
 */
export const collectionProductsSetSchema = z.object({
  productIds: z
    .array(z.string().uuid())
    .max(COLLECTION_MAX_PRODUCTS)
    .refine(uniqueProductIds, 'no repitas el mismo producto'),
});

/**
 * `POST /v1/admin/collections/:id/products` — append, without having to know
 * (or resend) what is already in the collection.
 *
 * Kept alongside the full-replace PUT rather than folded into it because the
 * two have different concurrency behaviour, and the difference matters to a
 * merchant with staff: appending cannot clobber a row somebody else added
 * thirty seconds ago, while a replace sent from a stale tab can. The picker
 * in the admin adds with this and only ever sends the full array when the
 * merchant has explicitly rearranged the list in front of them.
 *
 * `.min(1)` because an empty append is a no-op request, and answering 200 to
 * one hides a client bug that built an empty selection.
 */
export const collectionProductsAddSchema = z.object({
  productIds: z
    .array(z.string().uuid())
    .min(1)
    .max(COLLECTION_MAX_PRODUCTS)
    .refine(uniqueProductIds, 'no repitas el mismo producto'),
});

export type CollectionInput = z.infer<typeof collectionInputSchema>;
export type CollectionUpdate = z.infer<typeof collectionUpdateSchema>;
export type CollectionProductsSet = z.infer<typeof collectionProductsSetSchema>;
export type CollectionProductsAdd = z.infer<typeof collectionProductsAddSchema>;
