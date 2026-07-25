import './globals.css';
import { headers } from 'next/headers';
import { fetchTenantForHost } from '../lib/tenant';
import { buildThemeVars, type TenantTheme } from '../lib/theme';

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
  // handful of string fields off it. `null`/missing (draft tenant, or no
  // tenant resolved at all for this host) falls through to the neutral
  // defaults `buildThemeVars` already provides.
  const themeVars = buildThemeVars((tenant?.theme as TenantTheme | null) ?? null);

  return (
    <html lang="es-CO" style={themeVars as React.CSSProperties}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
