import './globals.css';
import { headers } from 'next/headers';
import { fetchTenantForHost } from '../lib/tenant';
import { buildThemeVars, type TenantTheme } from '../lib/theme';
import { fontVariables } from '../lib/fonts';
import { CartProvider } from '../lib/cart-context';
import { CartDrawer } from '../components/cart-drawer';
import { ChatWidget } from '../components/chat-widget';
import { SiteFooter } from '../components/site-footer';

export const metadata = { title: 'Ventia' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const host = (await headers()).get('host');
  const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
  const tenant = await fetchTenantForHost(host, apiUrl);

  // `tenant.theme` is `unknown` (lib/tenant.ts) — the API returns whatever
  // JSON the merchant last saved via `PUT /v1/admin/settings/theme`
  // (services/api/src/settings/settings.controller.ts), unvalidated at this
  // layer. Trusted here rather than re-validated: only the merchant's own
  // admin session can ever write it, and `buildThemeVars` only ever reads a
  // handful of string fields off it (including `fontPair`, which it does
  // validate against the fixed catalog via `fontPairVars` — see lib/theme.ts).
  // `null`/missing (draft tenant, or no tenant resolved at all for this host)
  // falls through to the neutral defaults `buildThemeVars` already provides.
  const themeVars = buildThemeVars((tenant?.theme as TenantTheme | null) ?? null);

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
