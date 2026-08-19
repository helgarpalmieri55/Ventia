import Link from 'next/link';

/**
 * The storefront's global footer, and specifically the place the store's
 * policy pages are actually reachable from.
 *
 * ## Why this is a legal requirement and not a layout preference
 *
 * Ley 1581 de 2012 art. 12 obliges the Responsable to INFORM the Titular of
 * the treatment and its purposes at the time of collection, and Decreto 1074
 * art. 2.2.2.25.3.1 requires the política de tratamiento to be *made known*
 * to the Titulares — "puesta en conocimiento", not merely written. Before
 * this component the four content pages existed at their URLs
 * (`/privacidad`, `/envios`, `/cambios-y-devoluciones`, `/contacto`) and
 * nothing in the entire storefront linked to any of them: the only way to
 * read a store's privacy policy was to guess its path. A policy nobody can
 * navigate to has not been published in any sense the law recognises.
 *
 * The checkout's authorization checkbox links straight to `/privacidad` for
 * the same reason, but that link only exists on one page, at the one moment
 * the shopper is trying to finish paying. This one is on every page, before
 * they have handed over anything.
 *
 * ## Shape
 *
 * A Server Component with no tenant lookup of its own. `RootLayout` already
 * resolves the tenant for theming, and this footer deliberately renders
 * nothing tenant-specific — the four routes are the same for every store, and
 * each page resolves its own tenant. Keeping it dependency-free means it
 * cannot fail, and a footer that 500s would take every page with it.
 *
 * `next/link` rather than a bare `<a>`, matching this app's other internal
 * navigation, so the four pages prefetch and navigate client-side.
 *
 * The labels are es-CO and match the pages' own headings (see
 * lib/policy-defaults.ts), with one deliberate exception noted inline below.
 */

/** Exported so `test/site-footer.test.ts` can pin the set of routes without a
 * DOM renderer (this app's vitest runs in a `node` environment and has no
 * testing-library — see vitest.config.ts). The list, not the markup, is the
 * part with a legal obligation attached to it. */
export const FOOTER_LINKS: { href: string; label: string }[] = [
  { href: '/envios', label: 'Envíos' },
  { href: '/cambios-y-devoluciones', label: 'Cambios y devoluciones' },
  // Named "Tratamiento de datos" rather than the bare "Privacidad" the page's
  // fallback title uses: "privacidad" is what an English-speaking web has
  // trained everyone to skim past, while a Colombian shopper looking for the
  // document that governs their Habeas Data rights is looking for the phrase
  // the law itself uses. The page title stays whatever the merchant published.
  { href: '/privacidad', label: 'Tratamiento de datos' },
  { href: '/contacto', label: 'Contacto' },
];

export function SiteFooter() {
  return (
    <footer className="mt-12 border-t border-border">
      <nav
        aria-label="Enlaces de la tienda"
        className="mx-auto flex max-w-5xl flex-wrap gap-x-6 gap-y-2 px-4 py-6 text-sm text-muted-foreground"
      >
        {FOOTER_LINKS.map((link) => (
          <Link key={link.href} href={link.href} className="hover:underline">
            {link.label}
          </Link>
        ))}
      </nav>
    </footer>
  );
}
