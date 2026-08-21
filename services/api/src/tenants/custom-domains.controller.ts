import { Body, Controller, Delete, Get, HttpCode, HttpException, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { platformDb } from '@ventia/db';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, Roles, type AdminSessionContext } from '../admin/roles.decorator';
import { writeAudit } from '../catalog/audit';
import { assertPlanFeature, isPlanFeatureEnabled } from '../common/plan-limits';
import { CustomDomainsService, normalizeDomain, platformRootDomain } from './custom-domains.service';

/**
 * Caddy's on-demand TLS gate. `GET /internal/tls-ask?domain=<host>`.
 *
 * Answers 200 to authorize issuance and 403 to refuse. Caddy issues only on a
 * 2xx, so this endpoint is the entire thing standing between "multi-tenant
 * custom domains" and "anyone who points DNS at us can burn the platform's
 * Let's Encrypt rate limit and take TLS down for every real tenant".
 *
 * Unauthenticated by necessity — Caddy calls it during a TLS handshake, before
 * any session exists. It is therefore mounted under `/internal` and MUST NOT
 * be exposed publicly by the reverse proxy; see docker/Caddyfile, where it is
 * reachable only from the proxy itself. Even so it leaks nothing: the only
 * observable is whether a hostname is served here, which a TLS handshake
 * reveals anyway.
 */
@Controller('internal')
export class TlsAskController {
  constructor(@Inject(CustomDomainsService) private readonly domains: CustomDomainsService) {}

  @Get('tls-ask')
  @HttpCode(200)
  async ask(@Query('domain') domain: string | undefined): Promise<string> {
    const allowed = domain ? await this.domains.isDomainAllowed(domain) : false;
    // 403, not 404: Caddy treats any non-2xx as a refusal, and 403 is the
    // honest code for "we will not issue for this".
    if (!allowed) throw new HttpException('not authorized for this domain', 403);
    return 'ok';
  }
}

/**
 * The merchant's custom-domain flow (owner-only, like every other settings
 * surface).
 *
 * Plan-gated on `TenantLimits.customDomain` — SPEC §5 lists it as a plan
 * entitlement, and without the gate the tier boundary is decorative.
 */
/** `PLATFORM_APEX_IP`, or `null` when it is unset or blank. Deliberately not
 * defaulted: an apex A record pointing at the wrong host does not degrade, it
 * takes the merchant's store off the internet. */
function apexIpOrNull(): string | null {
  const value = (process.env.PLATFORM_APEX_IP ?? '').trim();
  return value.length > 0 ? value : null;
}

@Controller('v1/admin/domains')
@UseGuards(AdminSessionGuard)
@Roles('owner')
export class CustomDomainsController {
  constructor(@Inject(CustomDomainsService) private readonly domains: CustomDomainsService) {}

  @Get()
  async list(@AdminSession() session: AdminSessionContext) {
    const root = platformRootDomain();
    const [items, customDomainEnabled, tenant] = await Promise.all([
      this.domains.listForTenant(session.tenantId),
      isPlanFeatureEnabled(session.tenantId, 'customDomain'),
      platformDb.tenant.findUniqueOrThrow({ where: { id: session.tenantId }, select: { slug: true } }),
    ]);
    return {
      items,
      customDomainEnabled,
      // What the merchant must publish. Returned alongside so the UI can show
      // the exact record rather than describing it in prose — a mistyped host
      // is the most common reason verification never completes.
      verificationHost: '_ventia-verify',
      // The platform's own zone. The admin panel used to derive this from its
      // own hostname because the API never sent it, which is exact only when
      // the panel is reached at `admin.${root}` — wrong on `localhost:3001`,
      // and a guess everywhere else. The server is the only place that knows
      // it (`PLATFORM_ROOT_DOMAIN`), so the server sends it.
      platformRootDomain: root,
      // Where a merchant's own domain has to point.
      //
      // The tenant's free subdomain, NOT whichever domain is currently
      // primary: `POST /:id/primary` lets a custom domain become primary, and
      // a UI that told the merchant to CNAME `mitienda.com` at
      // `mitienda.com` would be instructing them to build a loop. This address
      // exists from provisioning and never stops resolving here, whatever else
      // the store is called.
      pointsTo: `${tenant.slug}.${root}`,
      // The A record for a merchant whose domain is the bare apex, where most
      // DNS providers refuse a CNAME. `null` when the platform operator has
      // not set `PLATFORM_APEX_IP` — the UI then falls back to asking the
      // merchant to contact support, which is what it already did, rather than
      // this endpoint inventing an address that would silently black-hole a
      // live store.
      apexIp: apexIpOrNull(),
    };
  }

  @Post()
  async add(@AdminSession() session: AdminSessionContext, @Body() body: unknown) {
    const raw = (body as { domain?: unknown })?.domain;
    const domain = normalizeDomain(typeof raw === 'string' ? raw : null);
    if (!domain) {
      throw new HttpException({ error: 'VALIDATION_FAILED', details: { domain: 'dominio inválido' } }, 400);
    }

    // The shared gate rather than a hand-rolled 402: `common/plan-limits.ts`
    // is the single definition of this error's shape, so the admin UI renders
    // one upgrade prompt for every entitlement. It also fails closed on an
    // unprovisioned tenant, which is the posture every boolean feature uses.
    await assertPlanFeature(session.tenantId, 'customDomain');

    // Claimed by someone else — including by this same tenant, in which case
    // the honest answer is still "already registered". A 409 rather than a
    // silent takeover: `TenantDomain.domain` is globally unique because it is
    // what tenant resolution keys on, so reassigning it would redirect a live
    // storefront.
    const existing = await platformDb.tenantDomain.findUnique({ where: { domain } });
    if (existing) throw new HttpException({ error: 'DOMAIN_ALREADY_REGISTERED' }, 409);

    const added = await this.domains.add(session.tenantId, domain);
    await writeAudit(session, 'domain.add', 'TenantDomain', added.id, { domain });
    return added;
  }

  @Post(':id/verify')
  async verify(@AdminSession() session: AdminSessionContext, @Param('id') id: string) {
    const result = await this.domains.verify(session.tenantId, id);
    if (result.verified) await writeAudit(session, 'domain.verify', 'TenantDomain', id, {});
    // 200 either way: "not yet" is the expected state for minutes after a
    // merchant adds the record, and an error would read as "you did it wrong".
    //
    // `reason` rides along on the failures so the panel can say which of them
    // happened. Additive — `verified` still carries the same meaning it always
    // did, so a client that ignores `reason` behaves exactly as before.
    return result;
  }

  /** Makes a verified domain the store's public address — see
   * `CustomDomainsService#setPrimary` for why connecting a domain is not the
   * same as being it. 409 rather than 400 on an unverified domain: the request
   * is well-formed, the domain is simply not ready yet. */
  @Post(':id/primary')
  async setPrimary(@AdminSession() session: AdminSessionContext, @Param('id') id: string) {
    const promoted = await this.domains.setPrimary(session.tenantId, id);
    if (!promoted) throw new HttpException({ error: 'DOMAIN_NOT_VERIFIED' }, 409);
    await writeAudit(session, 'domain.set_primary', 'TenantDomain', id, { domain: promoted.domain });
    return { ok: true, domain: promoted.domain };
  }

  @Delete(':id')
  async remove(@AdminSession() session: AdminSessionContext, @Param('id') id: string) {
    const result = await this.domains.remove(session.tenantId, id);
    if (!result.ok) {
      // 404 for "not yours" (a tenant must not learn another's ids exist);
      // 409 for the two refusals, because the request is well-formed and the
      // merchant can act on it — promote another domain, or keep this one.
      if (result.reason === 'not_found') throw new HttpException({ error: 'DOMAIN_NOT_FOUND' }, 404);
      throw new HttpException(
        { error: result.reason === 'is_primary' ? 'DOMAIN_IS_PRIMARY' : 'DOMAIN_LAST' },
        409,
      );
    }
    await writeAudit(session, 'domain.remove', 'TenantDomain', id, {});
    return { ok: true };
  }
}
