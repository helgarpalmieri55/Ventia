import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';

/** Allow-all robots.txt referencing this same host's sitemap.ts. No tenant
 * resolution needed (unlike sitemap.ts) — the rules are identical whether or
 * not the host resolves to a live tenant, only the origin used to build the
 * sitemap URL depends on the request. */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const hdrs = await headers();
  const host = hdrs.get('host') ?? 'localhost';
  // Caddy's reverse_proxy sets this header in dev (see docker/Caddyfile);
  // default to 'https' for safety in any non-dev/non-Caddy context.
  const protocol = hdrs.get('x-forwarded-proto') ?? 'https';
  const origin = `${protocol}://${host}`;

  return {
    rules: { userAgent: '*', allow: '/' },
    sitemap: `${origin}/sitemap.xml`,
  };
}
