/** Turns a resolved tenant DOMAIN (a `TenantDomain.domain` row, e.g.
 * `demo-moda.ventia.localhost` or a fully custom `tienda.example.com`) into
 * the PUBLIC, browser-reachable base URL of that tenant's storefront.
 *
 * This is the API-side half of the payment-redirect multi-tenancy fix. The
 * value produced here is what `checkout.service.ts` puts on
 * `OrderForPayment.storefrontBaseUrl`, and what the Wompi/ePayco adapters then
 * build their `redirect-url` / bridge-page / `response` URLs on top of. Before
 * it existed, those adapters read ONE global env var
 * (`PAYMENTS_STOREFRONT_BASE_URL`) and every tenant's shopper was redirected
 * to whichever single storefront it named.
 *
 * Kept deliberately small and dependency-free (a pure function over a domain
 * string plus an injectable env source, mirroring
 * `payments/encryption.ts`'s own `source`-parameter convention) so it is
 * unit-testable with no Nest graph, no Redis and no database.
 */

/** Explicit override for the scheme half of the base URL. Values: `http` or
 * `https`. Anything else THROWS rather than being ignored — a typo here would
 * otherwise silently fall back to the inferred scheme and produce redirects
 * nobody notices are wrong, which is the failure mode this whole change
 * exists to remove. */
export const STOREFRONT_SCHEME_ENV_VAR = 'STOREFRONT_PUBLIC_SCHEME';

/** Hostnames (and host suffixes) that are, by definition, not reachable over
 * a publicly-trusted TLS certificate, and which this repo's dev stack actually
 * uses: Caddy serves `http://*.ventia.localhost` on port 80 (docker/Caddyfile)
 * and the seeded tenants own `demo-moda.ventia.localhost` /
 * `demo-tech.ventia.localhost` `TenantDomain` rows. `.local` and `.test` are
 * the other two reserved-for-local names in common use.
 *
 * Note `.localhost` is a RESERVED special-use TLD (RFC 6761), not a name
 * anyone can register — so treating it as plaintext-http cannot be turned into
 * a downgrade against a real production domain. */
const LOCAL_HOST_EXACT = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const LOCAL_HOST_SUFFIXES = ['.localhost', '.local', '.test'];

/** Decides `http` vs `https` for a tenant's public storefront URL.
 *
 * ## Why this is a documented rule and not an accident
 *
 * The old global env var carried its scheme inside the URL, so the choice was
 * never made anywhere — it was whatever someone happened to type. Now that the
 * host comes from the database, the scheme has to be decided explicitly. The
 * rule, in priority order:
 *
 *  1. **`STOREFRONT_PUBLIC_SCHEME`, if set**, wins for every tenant. This is
 *     the escape hatch for a deployment the inference below gets wrong (e.g.
 *     an internal staging domain served over plain HTTP). An unrecognized
 *     value throws at the point of use rather than being silently dropped.
 *  2. **Otherwise, local/reserved hostnames get `http`** — `localhost`,
 *     `*.localhost` (this repo's whole dev stack), `*.local`, `*.test`,
 *     loopback literals.
 *  3. **Otherwise, `https`.**
 *
 * Rule 3 is the safe default in the direction that matters: a REAL registered
 * domain that this function has never seen gets `https`, so forgetting to
 * configure anything in production cannot produce a plaintext redirect. The
 * inverse default (`http` unless told otherwise) would have exactly that
 * failure mode, silently, for every shopper. And because rule 2 only ever
 * matches names that cannot be registered publicly, it can never downgrade a
 * real production storefront.
 */
export function resolveStorefrontScheme(
  domain: string,
  env: Record<string, string | undefined> = process.env,
): 'http' | 'https' {
  const override = env[STOREFRONT_SCHEME_ENV_VAR]?.trim();
  if (override !== undefined && override.length > 0) {
    if (override !== 'http' && override !== 'https') {
      throw new Error(
        `${STOREFRONT_SCHEME_ENV_VAR} must be exactly 'http' or 'https', got ${JSON.stringify(override)}`,
      );
    }
    return override;
  }

  // Classify on the HOSTNAME, not the authority: `localhost:3000` is as local
  // as `localhost`, and a port never changes whether a name is publicly
  // registrable.
  // Strips only a trailing `:<digits>` port, so IPv6 literals (which are all
  // colons) survive intact.
  const host = domain.trim().toLowerCase().replace(/:\d+$/, '');
  if (LOCAL_HOST_EXACT.has(host)) return 'http';
  if (LOCAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return 'http';
  return 'https';
}

/** Characters that would let a stored domain smuggle URL STRUCTURE into the
 * base URL rather than just naming a host: a path, a query, a fragment,
 * userinfo, a second scheme, or (via whitespace) a value some parser splits
 * differently from another. Checked explicitly, before parsing, so the failure
 * message names the real problem. */
const STRUCTURAL_CHARS = /[\s/\\?#@]/;

/** Builds the tenant's public storefront base URL — origin only, no trailing
 * slash — from its resolved domain.
 *
 * Throws on a domain that is empty, or that is anything other than a bare host
 * (optionally with a port). Every real value here comes from
 * `TenantDomain.domain` via `DomainResolver`, so a value that fails these
 * checks means either a corrupt row or a caller passing the wrong thing — both
 * of which must fail loudly rather than produce a redirect pointing somewhere
 * unintended. `packages/payments`'s `requireStorefrontBaseUrl` re-validates the
 * assembled URL independently at the adapter boundary; this is the earlier,
 * host-shaped half of the same posture.
 *
 * Validated by CONSTRUCTING the URL and checking what came out, rather than by
 * a character allowlist on the host. An allowlist tight enough to be
 * meaningful (`[a-z0-9.-]`) also rejects things that are legitimately
 * registrable — an internationalized domain stored in raw Unicode, an
 * underscore some registrars permit — and rejecting a real merchant's domain
 * would 500 their entire checkout. Round-tripping through `URL` accepts those
 * and, as a bonus, normalizes an IDN to the punycode form a payment gateway
 * actually wants, while still rejecting every structural shape above.
 *
 * A port IS permitted (`localhost:3000`) — a legitimate part of a dev host —
 * though `DomainResolver` is fed a port-stripped host by `normalizeHost`, so
 * real resolved domains never carry one today.
 */
export function tenantStorefrontBaseUrl(
  domain: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  if (typeof domain !== 'string' || domain.trim().length === 0) {
    throw new Error('tenantStorefrontBaseUrl: tenant domain is required');
  }
  const host = domain.trim().toLowerCase();
  if (STRUCTURAL_CHARS.test(host)) {
    throw new Error(
      `tenantStorefrontBaseUrl: tenant domain must be a bare host, got ${JSON.stringify(domain)}`,
    );
  }

  const scheme = resolveStorefrontScheme(host, env);
  let parsed: URL;
  try {
    parsed = new URL(`${scheme}://${host}`);
  } catch {
    throw new Error(
      `tenantStorefrontBaseUrl: tenant domain must be a bare host, got ${JSON.stringify(domain)}`,
    );
  }
  // Belt and braces over the character check above: anything `URL` decided was
  // a path/query/fragment/credential means the input was not a bare host.
  if (
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.protocol !== `${scheme}:`
  ) {
    throw new Error(
      `tenantStorefrontBaseUrl: tenant domain must be a bare host, got ${JSON.stringify(domain)}`,
    );
  }
  // `origin`, not `${scheme}://${host}`: it drops a redundant default port and
  // emits the punycode form of an IDN.
  return parsed.origin;
}
