import './globals.css';
import { headers } from 'next/headers';
import { fetchTenantForHost } from '../lib/tenant';
import { fetchStorefrontOrNull } from '../lib/storefront-api';
import { buildCategoryNav, type StorefrontCategory } from '../lib/category-tree';
import { buildThemeVars, type TenantTheme } from '../lib/theme';
import { fontVariables } from '../lib/fonts';
import { CartProvider } from '../lib/cart-context';
import { CartDrawer } from '../components/cart-drawer';
import { ChatWidget } from '../components/chat-widget';
import { SiteHeader } from '../components/site-header';
import { SiteFooter } from '../components/site-footer';

export const metadata = { title: 'Ventia' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const host = (await headers()).get('host');
  const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
  // The header's categories are resolved here, once, rather than by the header
  // itself: the home and category pages already fetch the same list, and Next
  // request-memoizes identical `fetch()` calls within a render, so at the
  // layout level this is usually the same round trip rather than an extra one.
  //
  // In parallel with the tenant rather than after it, deliberately: this is on
  // the critical path of every page in the store, and the only thing waiting
  // would buy is skipping one request for a host that resolves to no tenant at
  // all (where the API answers 404 and this lands on `null` anyway).
  //
  // fetchStorefrontOrNull (not fetchStorefront), for a stronger reason than
  // the pages have: a 5xx from the categories endpoint must degrade to a
  // header with no nav, never to a crashed layout that takes the checkout down
  // with it.
  const [tenant, categoryRows] = await Promise.all([
    fetchTenantForHost(host, apiUrl),
    host ? fetchStorefrontOrNull<StorefrontCategory[]>(host, '/v1/storefront/categories') : null,
  ]);
  const categories = buildCategoryNav(categoryRows ?? []);

  // `tenant.theme` is `unknown` (lib/tenant.ts) — the API returns whatever
  // JSON the merchant last saved via `PUT /v1/admin/settings/theme`
  // (services/api/src/settings/settings.controller.ts), unvalidated at this
  // layer. Trusted here rather than re-validated: only the merchant's own
  // admin session can ever write it, and `buildThemeVars` only ever reads a
  // handful of string fields off it (including `fontPair`, which it does
  // validate against the fixed catalog via `fontPairVars` — see lib/theme.ts).
  // `null`/missing (draft tenant, or no tenant resolved at all for this host)
  // falls through to the neutral defaults `buildThemeVars` already provides.
  const theme = (tenant?.theme as TenantTheme | null) ?? null;
  const themeVars = buildThemeVars(theme);

  // Same unvalidated blob, so the header gets a logo only when the saved value
  // really is a non-empty string — `<img src={someObject}>` would otherwise
  // render a broken image at the top of every page of the store.
  const logoUrl = typeof theme?.logoUrl === 'string' && theme.logoUrl !== '' ? theme.logoUrl : undefined;

  return (
    // `fontVariables` (lib/fonts.ts) puts all 10 catalog fonts' CSS variables
    // in scope on <html> — `themeVars`' `--font-heading`/`--font-body` (set
    // per this tenant's saved `fontPair`) then pick the two that resolve to
    // an actual font, via `globals.css`'s `body`/heading rules.
    <html lang="es-CO" className={fontVariables} style={themeVars as React.CSSProperties}>
      <body className="antialiased">
        {/* `CartProvider`/`CartDrawer` are this app's first client
            components (P2b) — `RootLayout` itself stays a Server Component
            (it still needs `headers()`/tenant/theme resolution above); a
            Server Component rendering a Client Component as `children`'s
            sibling is ordinary Next.js composition, no serialization concern
            since nothing unserializable crosses that boundary. */}
        <CartProvider>
          <CartDrawer />
          {/* Inside `CartProvider` because the header owns the cart trigger
              (components/cart-button.tsx) — it used to float over the page as
              a fixed circle, which would now collide with the sticky header.
              Skipped entirely for an unresolved host: there is no store to
              name, and app/page.tsx renders the platform landing copy. */}
          {tenant ? (
            <SiteHeader storeName={tenant.name} logoUrl={logoUrl} categories={categories} />
          ) : null}
          {children}
          {/* Rendered for every store, unconditionally. The four pages it
              links are the ones Ley 1581 art. 12 / Decreto 1074 require to be
              *made known* rather than merely to exist at a URL, and before
              this the storefront linked to none of them from anywhere. Inside
              CartProvider only because it is `children`'s sibling; it is a
              plain Server Component and uses no cart state. */}
          <SiteFooter />
          {/* Only for a store whose plan actually includes AI messages — see
              `agentEnabled` on the tenant resolve. Offering a chat that can
              only answer "no puedo responderte por chat" is worse than
              offering none. */}
          {tenant?.agentEnabled ? <ChatWidget agentName={tenant.agentName} /> : null}
        </CartProvider>
      </body>
    </html>
  );
}
