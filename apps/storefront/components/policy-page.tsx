import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { fetchTenantForHost } from '../lib/tenant';
import { fetchStorefrontOrNull } from '../lib/storefront-api';
import { policyDefault, type PolicyType } from '../lib/policy-defaults';

/** Shape of `GET /v1/storefront/content/:type`'s 200 response (see
 * services/api/src/storefront/content.controller.ts) — kept local like this
 * app's other storefront DTOs. */
interface StorefrontContent {
  title: string;
  bodyMd: string;
}

/** Shared body for the four near-identical static content pages
 * (envios/cambios-y-devoluciones/privacidad/contacto): resolve tenant, fetch
 * the merchant's content for `type`, fall back to `policyDefault(type)` when
 * unset or unreachable, then render `bodyMd` as plain paragraphs split on a
 * blank line. Extracted here (unlike this codebase's ban on new pure-logic
 * helpers, e.g. Task 7's variant-derivation) because these four pages are
 * genuinely identical end-to-end — tenant resolution, fetch path, fallback,
 * and markup never diverge between them, so four copy-pasted page files would
 * just be four places to keep in sync instead of one. */
export async function PolicyPage({ type }: { type: PolicyType }) {
  const host = (await headers()).get('host');
  const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
  const tenant = await fetchTenantForHost(host, apiUrl);

  // Same posture as categorias/[slug]/page.tsx and productos/[slug]/page.tsx:
  // no "platform landing" concept exists for these routes, so an unresolved
  // tenant is a plain 404.
  if (!tenant) notFound();

  // `host` is guaranteed non-null here (see categorias/[slug]/page.tsx's
  // identical comment).
  const tenantHost = host as string;

  // fetchStorefrontOrNull (not fetchStorefront): a `null` result means "use
  // the default copy" regardless of *why* the fetch didn't produce content —
  // a genuine 404 (merchant hasn't written this page) and a transient
  // upstream error are both handled the same way here, unlike the PDP/category
  // pages where a transient error must NOT silently look like "not found".
  const content = await fetchStorefrontOrNull<StorefrontContent>(tenantHost, `/v1/storefront/content/${type}`);
  const { title, bodyMd } = content ?? policyDefault(type);

  // No markdown renderer dependency added (per the brief) — the simplest
  // possible rendering: a blank line separates paragraphs, each becomes a <p>.
  const paragraphs = bodyMd.split('\n\n');

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-8">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <div className="flex flex-col gap-4 text-sm text-muted-foreground">
        {paragraphs.map((paragraph, i) => (
          <p key={i}>{paragraph}</p>
        ))}
      </div>
    </main>
  );
}
