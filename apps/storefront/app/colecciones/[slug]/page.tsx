import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { fetchTenantForHost } from '../../../lib/tenant';
import { fetchCollection } from '../../../lib/collections-api';
import { ProductGrid } from '../../../components/product-grid';

/**
 * A collection's own page — where "Ver todo" on a home-page strip leads, and
 * where the merchant's WhatsApp broadcast points.
 *
 * Built to the shape of `app/categorias/[slug]/page.tsx`, deliberately: a
 * shopper who lands here from a link has no idea whether they are looking at a
 * category or a curated row, and the two must not feel like two different
 * stores. Same breadcrumb, same `ProductGrid`, same tenant resolution, same
 * `notFound()` on an unresolvable tenant.
 *
 * One difference, and it is the reason this page exists rather than the strip
 * being the whole feature: the collection's DESCRIPTION is rendered here. It
 * is the only place in the storefront with room for the sentence the merchant
 * wrote about their own sale.
 */
export default async function CollectionPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const host = (await headers()).get('host');
  const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
  const tenant = await fetchTenantForHost(host, apiUrl);

  // No "platform landing" concept for a collection sub-route (unlike
  // app/page.tsx's unknown-host branch), so an unresolved tenant is a plain
  // 404 here. A suspended tenant never reaches this component at all —
  // middleware.ts already answered with a real 503 upstream of any routing.
  if (!tenant) notFound();

  // `host` is guaranteed non-null here (see app/page.tsx's identical comment).
  const tenantHost = host as string;

  // ONE request, unlike the category page — which has to fetch the store's
  // whole category list and find its slug in it, because that endpoint has no
  // single-slug lookup. This one does, so a store with sixty curated rows does
  // not ship all sixty to render one.
  const collection = await fetchCollection(tenantHost, slug);
  // Covers a deleted collection, one the merchant has hidden, a mistyped URL,
  // and a momentarily unreachable API. The first three are genuinely "not
  // here"; the fourth is a wrong answer we prefer to a crashed page.
  if (!collection) notFound();

  // Kept out of the JSX so the two branches below read as the one decision
  // they are: whether this collection has anything to sell today.
  const hasProducts = collection.products.length > 0;
  // `?? ''` guards an older deployed API answering a newer storefront (the
  // same case `STRIP_MAX_PRODUCTS` is a second bound for): `descriptionMd` was
  // added to this response with this page, and a missing field must cost the
  // page its paragraph, not its render.
  const description = (collection.descriptionMd ?? '').trim();

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
      {/* The way back. A shopper arriving from a broadcast link has no history
          to go back through, and a collection has no parent to climb to — so
          "Inicio" is the whole trail, and it is the only exit from this page
          that does not require the header's menu. */}
      <nav aria-label="Ruta de navegación" className="text-sm text-muted-foreground">
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <li>
            <Link href="/" className="hover:underline">
              Inicio
            </Link>
          </li>
          <li className="flex items-center gap-x-2">
            <span aria-hidden="true">›</span>
            {/* The page you are on is not a link to itself. */}
            <span className="text-foreground" aria-current="page">
              {collection.name}
            </span>
          </li>
        </ol>
      </nav>

      <h1 className="text-2xl font-semibold">{collection.name}</h1>

      {description ? (
        // Plain text with line breaks preserved — this app still has no
        // markdown renderer (same as the product description and the review
        // bodies), and rendering it as HTML would be a new class of risk for
        // a paragraph that is currently only ever a paragraph.
        <p className="max-w-2xl whitespace-pre-wrap text-muted-foreground">{description}</p>
      ) : null}

      {hasProducts ? (
        <ProductGrid products={collection.products} />
      ) : (
        // NOT a 404, and not `ProductGrid`'s "No hay productos para mostrar"
        // either. The collection is real and the merchant's own link points
        // here; what changed is that the sale ended or has not been filled
        // yet. Saying that, and offering the way on, is the difference
        // between a store that closed a section and a store that looks
        // broken.
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">
            Esta colección no tiene productos disponibles en este momento.
          </p>
          <Link
            href="/"
            className="rounded-full border border-border px-4 py-2 text-sm transition-colors hover:bg-muted"
          >
            Ver el resto de la tienda
          </Link>
        </div>
      )}
    </main>
  );
}
