import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { CustomDomainsService as CustomDomainsServiceType } from '../src/tenants/custom-domains.service';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';

/**
 * Custom domains, and the on-demand TLS gate.
 *
 * The `ask` endpoint is the entire thing standing between multi-tenant custom
 * domains and an attacker burning the platform's shared Let's Encrypt issuance
 * budget — which would block certificate renewal for every real tenant. Every
 * condition it checks gets its own test, because each removal is a separate
 * way to hand out certificates for domains this platform does not serve.
 */

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClientType;
let app: INestApplication;
let domains: CustomDomainsServiceType;
let signUpWithTenant: typeof SignUpWithTenant;

let cookie: string;
let tenantId: string;

beforeAll(async () => {
  db = await startTestDb();
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = 'redis://localhost:6379';

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();

  ({ platformDb: prisma } = await import('@ventia/db'));
  ({ signUpWithTenant } = await import('./admin-helpers'));
  const { CustomDomainsService } = await import('../src/tenants/custom-domains.service');
  domains = app.get(CustomDomainsService);

  ({ cookie, tenantId } = await signUpWithTenant('domains-owner@demo.co', 'owner'));
  await prisma.tenantLimits.upsert({
    where: { tenantId },
    create: { tenantId, productsMax: 100, aiCreditsMonth: 100, staffSeats: 2, customDomain: true },
    update: { customDomain: true },
  });
}, 240_000);

afterAll(async () => {
  await app.close();
  await db.stop();
});

/** A verified, live, entitled domain — the only combination that may issue. */
async function seedServableDomain(domain: string) {
  await prisma.tenantDomain.create({
    data: { tenantId, domain, isPrimary: false, verifiedAt: new Date() },
  });
}

describe('normalizeDomain', () => {
  it('strips what a merchant realistically pastes', async () => {
    const { normalizeDomain } = await import('../src/tenants/custom-domains.service');
    expect(normalizeDomain('  HTTPS://Tienda.Example.COM/algo  ')).toBe('tienda.example.com');
    expect(normalizeDomain('tienda.example.com.')).toBe('tienda.example.com');
    expect(normalizeDomain('tienda.example.com:443')).toBe('tienda.example.com');
  });

  it('rejects what would loosen the certificate check', async () => {
    // This value is compared against a DB column to decide issuance, so a
    // loose normalizer is a way to match a row you should not.
    const { normalizeDomain } = await import('../src/tenants/custom-domains.service');
    expect(normalizeDomain('*.example.com')).toBeNull();
    expect(normalizeDomain('localhost')).toBeNull(); // single label
    expect(normalizeDomain('-bad.example.com')).toBeNull();
    expect(normalizeDomain('exa mple.com')).toBeNull();
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain(null)).toBeNull();
  });
});

describe('GET /internal/tls-ask — the issuance gate', () => {
  it('authorizes a verified domain of a live, entitled tenant', async () => {
    await seedServableDomain('servable.example.com');

    const res = await request(app.getHttpServer()).get('/internal/tls-ask').query({ domain: 'servable.example.com' });
    expect(res.status).toBe(200);
  });

  it('REFUSES a domain nobody registered', async () => {
    const res = await request(app.getHttpServer()).get('/internal/tls-ask').query({ domain: 'attacker.example.com' });
    expect(res.status).toBe(403);
  });

  it('REFUSES a registered but UNVERIFIED domain', async () => {
    // A row proves nothing — a merchant can type a competitor's hostname into
    // the form. Only DNS control proves it is theirs.
    await prisma.tenantDomain.create({
      data: { tenantId, domain: 'unverified.example.com', isPrimary: false },
    });

    const res = await request(app.getHttpServer())
      .get('/internal/tls-ask')
      .query({ domain: 'unverified.example.com' });
    expect(res.status).toBe(403);
  });

  it('REFUSES a suspended tenant\'s domain', async () => {
    // Suspension exists to stop serving a store; renewing its certificate
    // works against that.
    const { tenantId: suspendedId } = await signUpWithTenant('domains-suspended@demo.co', 'owner');
    await prisma.tenantLimits.upsert({
      where: { tenantId: suspendedId },
      create: { tenantId: suspendedId, productsMax: 10, aiCreditsMonth: 10, staffSeats: 1, customDomain: true },
      update: { customDomain: true },
    });
    await prisma.tenantDomain.create({
      data: { tenantId: suspendedId, domain: 'suspended.example.com', isPrimary: false, verifiedAt: new Date() },
    });
    await prisma.tenant.update({ where: { id: suspendedId }, data: { status: 'suspended' } });

    const res = await request(app.getHttpServer())
      .get('/internal/tls-ask')
      .query({ domain: 'suspended.example.com' });
    expect(res.status).toBe(403);
  });

  it('REFUSES a tenant whose plan does not include custom domains', async () => {
    // Otherwise the entitlement is decorative: a downgraded store keeps
    // renewing forever.
    const { tenantId: basicId } = await signUpWithTenant('domains-basic@demo.co', 'owner');
    await prisma.tenantLimits.upsert({
      where: { tenantId: basicId },
      create: { tenantId: basicId, productsMax: 10, aiCreditsMonth: 10, staffSeats: 1, customDomain: false },
      update: { customDomain: false },
    });
    await prisma.tenantDomain.create({
      data: { tenantId: basicId, domain: 'basic.example.com', isPrimary: false, verifiedAt: new Date() },
    });

    const res = await request(app.getHttpServer()).get('/internal/tls-ask').query({ domain: 'basic.example.com' });
    expect(res.status).toBe(403);
  });

  it('AUTHORIZES a basic-plan tenant\'s OWN platform subdomain', async () => {
    // The bug this pins, found while preparing the first real deploy and
    // never reachable in development because `.localhost` needs no
    // certificate.
    //
    // onboarding.service.ts gives every tenant `${slug}.${PLATFORM_ROOT_DOMAIN}`,
    // verified and primary. `emprende.customDomain` is false. With the plan gate
    // applied to that row, Caddy is refused a certificate for the store's own
    // address — so every basic-plan storefront has no HTTPS and is simply
    // unreachable. The plan sells CUSTOM domains; the free subdomain is the
    // product.
    const root = process.env.PLATFORM_ROOT_DOMAIN ?? 'ventia.localhost';
    const { tenantId: basicId } = await signUpWithTenant('domains-own-subdomain@demo.co', 'owner');
    await prisma.tenantLimits.upsert({
      where: { tenantId: basicId },
      create: { tenantId: basicId, productsMax: 10, aiCreditsMonth: 10, staffSeats: 1, customDomain: false },
      update: { customDomain: false },
    });
    await prisma.tenantDomain.create({
      data: { tenantId: basicId, domain: `mitienda.${root}`, isPrimary: true, verifiedAt: new Date() },
    });

    const res = await request(app.getHttpServer()).get('/internal/tls-ask').query({ domain: `mitienda.${root}` });
    expect(res.status).toBe(200);
  });

  it('does NOT treat a lookalike domain as being in our zone', async () => {
    // `endsWith(root)` without the leading dot would match `evilventia.co`
    // against `ventia.co`, letting anyone who registers a lookalike skip the
    // plan gate by living in a zone that is not ours.
    const root = process.env.PLATFORM_ROOT_DOMAIN ?? 'ventia.localhost';
    const { tenantId: lookalikeId } = await signUpWithTenant('domains-lookalike@demo.co', 'owner');
    await prisma.tenantLimits.upsert({
      where: { tenantId: lookalikeId },
      create: { tenantId: lookalikeId, productsMax: 10, aiCreditsMonth: 10, staffSeats: 1, customDomain: false },
      update: { customDomain: false },
    });
    await prisma.tenantDomain.create({
      data: { tenantId: lookalikeId, domain: `evil${root}`, isPrimary: false, verifiedAt: new Date() },
    });

    const res = await request(app.getHttpServer()).get('/internal/tls-ask').query({ domain: `evil${root}` });
    expect(res.status).toBe(403);
  });

  it('REFUSES a missing or malformed domain parameter rather than erroring', async () => {
    // Caddy treats any non-2xx as refusal, so failing closed here is correct
    // AND must not 500 — a 500 in this path is a certificate outage.
    expect((await request(app.getHttpServer()).get('/internal/tls-ask')).status).toBe(403);
    expect(
      (await request(app.getHttpServer()).get('/internal/tls-ask').query({ domain: '*.example.com' })).status,
    ).toBe(403);
  });
});

describe('POST /v1/admin/domains/:id/primary — being the domain, not just having it', () => {
  it('promotes a verified domain and demotes the platform subdomain', async () => {
    // The point of a custom domain. `isPrimary` is what
    // whatsapp-inbound.service.ts reads to build the links the agent sends to
    // real shoppers, and what privacy-policy.service.ts quotes as the store's
    // web address. Until this endpoint existed, a merchant could connect
    // `mitienda.com`, verify it and get a certificate while their customers
    // kept receiving links to `mitienda.ventia.localhost`.
    const root = process.env.PLATFORM_ROOT_DOMAIN ?? 'ventia.localhost';
    const sub = await prisma.tenantDomain.create({
      data: { tenantId, domain: `primary-sub.${root}`, isPrimary: true, verifiedAt: new Date() },
    });
    const custom = await prisma.tenantDomain.create({
      data: { tenantId, domain: 'promoteme.example.com', isPrimary: false, verifiedAt: new Date() },
    });

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/domains/${custom.id}/primary`)
      .set('Cookie', cookie);
    expect(res.status).toBe(201);

    expect((await prisma.tenantDomain.findUniqueOrThrow({ where: { id: custom.id } })).isPrimary).toBe(true);
    // Exactly one primary: two would make `find(d => d.isPrimary)` return
    // whichever row the database yielded first, so a shopper's link host would
    // change run to run.
    expect((await prisma.tenantDomain.findUniqueOrThrow({ where: { id: sub.id } })).isPrimary).toBe(false);
    expect(await prisma.tenantDomain.count({ where: { tenantId, isPrimary: true } })).toBe(1);
  });

  it('REFUSES to promote an unverified domain', async () => {
    // `verifiedAt` is the only evidence the merchant controls the name.
    // Promoting an unverified one puts a hostname nobody has proven into every
    // outbound link and into a published legal document — and since
    // isDomainAllowed refuses it a certificate, those links land on a TLS
    // error.
    const unverified = await prisma.tenantDomain.create({
      data: { tenantId, domain: 'notyet.example.com', isPrimary: false },
    });

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/domains/${unverified.id}/primary`)
      .set('Cookie', cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('DOMAIN_NOT_VERIFIED');
    expect((await prisma.tenantDomain.findUniqueOrThrow({ where: { id: unverified.id } })).isPrimary).toBe(false);
  });

  it('REFUSES another tenant\'s domain', async () => {
    const other = await signUpWithTenant('domains-primary-other@demo.co', 'owner');
    const theirs = await prisma.tenantDomain.create({
      data: { tenantId: other.tenantId, domain: 'theirs-primary.example.com', isPrimary: false, verifiedAt: new Date() },
    });

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/domains/${theirs.id}/primary`)
      .set('Cookie', cookie);
    expect(res.status).toBe(409);
    expect((await prisma.tenantDomain.findUniqueOrThrow({ where: { id: theirs.id } })).isPrimary).toBe(false);
  });
});

describe('DELETE /v1/admin/domains/:id — las dos negativas', () => {
  it('REFUSES to delete the tenant\'s last domain', async () => {
    // Un comercio sin ninguna fila TenantDomain no tiene dirección: el
    // DomainResolver no lo resuelve, la tienda es inalcanzable, y
    // storefrontBaseUrl arma enlaces desde ''. Tampoco es recuperable desde el
    // panel: `add()` está limitado por plan, así que un comercio en básico que
    // borre su propio subdominio no puede volver a ponerlo.
    // `signUpWithTenant` crea el tenant directamente, sin pasar por
    // onboarding, así que no trae dominio: se lo damos aquí para que tenga
    // exactamente uno, que es el estado que esta prueba persigue.
    const solo = await signUpWithTenant('domains-last@demo.co', 'owner');
    const only = await prisma.tenantDomain.create({
      data: { tenantId: solo.tenantId, domain: 'solo-domain.example.com', isPrimary: true, verifiedAt: new Date() },
    });

    const res = await request(app.getHttpServer())
      .delete(`/v1/admin/domains/${only.id}`)
      .set('Cookie', solo.cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('DOMAIN_LAST');
    expect(await prisma.tenantDomain.count({ where: { tenantId: solo.tenantId } })).toBe(1);
  });

  it('REFUSES to delete the primary while others remain', async () => {
    // Borrar el principal deja `find(d => d.isPrimary)` en undefined, y
    // storefrontBaseUrl cae a su desempate alfabético: el host de cada enlace
    // que el agente manda a los compradores cambia, en silencio, al dominio que
    // ordene primero. Reasignar el principal automáticamente sería peor —
    // elegiría una dirección pública nueva sin que nadie lo decidiera.
    await prisma.tenantDomain.create({
      data: { tenantId, domain: 'secondary-del.example.com', isPrimary: false, verifiedAt: new Date() },
    });
    const primary = await prisma.tenantDomain.findFirstOrThrow({ where: { tenantId, isPrimary: true } });

    const res = await request(app.getHttpServer())
      .delete(`/v1/admin/domains/${primary.id}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('DOMAIN_IS_PRIMARY');
    expect(await prisma.tenantDomain.findUnique({ where: { id: primary.id } })).not.toBeNull();
  });

  it('deletes a non-primary domain when another remains', async () => {
    const extra = await prisma.tenantDomain.create({
      data: { tenantId, domain: 'deleteme-ok.example.com', isPrimary: false, verifiedAt: new Date() },
    });
    const res = await request(app.getHttpServer())
      .delete(`/v1/admin/domains/${extra.id}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(await prisma.tenantDomain.findUnique({ where: { id: extra.id } })).toBeNull();
  });
});

describe('domain verification', () => {
  it('marks verified when the expected TXT record is published', async () => {
    const added = await domains.add(tenantId, 'verifyme.example.com');
    const token = domains.verificationToken(tenantId, 'verifyme.example.com');
    const resolver = vi.fn().mockResolvedValue([[token]]);

    const ok = await domains.verify(tenantId, added.id, resolver);

    expect(ok).toEqual({ verified: true });
    expect(resolver).toHaveBeenCalledWith('_ventia-verify.verifyme.example.com');
    const row = await prisma.tenantDomain.findUniqueOrThrow({ where: { id: added.id } });
    expect(row.verifiedAt).not.toBeNull();
  });

  it('rejoins a TXT value the DNS protocol split into chunks', async () => {
    // Long TXT values arrive as multiple strings; comparing the first chunk
    // alone would never match.
    const added = await domains.add(tenantId, 'chunked.example.com');
    const token = domains.verificationToken(tenantId, 'chunked.example.com');
    const resolver = vi.fn().mockResolvedValue([[token.slice(0, 10), token.slice(10)]]);

    expect(await domains.verify(tenantId, added.id, resolver)).toEqual({ verified: true });
  });

  it('does NOT verify on a wrong token, and says the value is the problem', async () => {
    // `record_mismatch` and not a bare failure: the merchant published
    // something, so the panel can point them at the value instead of telling
    // them to wait for propagation that already happened.
    const added = await domains.add(tenantId, 'wrongtoken.example.com');
    const resolver = vi.fn().mockResolvedValue([['not-the-token']]);

    expect(await domains.verify(tenantId, added.id, resolver)).toEqual({
      verified: false,
      reason: 'record_mismatch',
    });
    const row = await prisma.tenantDomain.findUniqueOrThrow({ where: { id: added.id } });
    expect(row.verifiedAt).toBeNull();
  });

  it('reports a DNS failure as "not yet", not as an error', async () => {
    // A merchant who just added the record is genuinely in this state for
    // minutes.
    const added = await domains.add(tenantId, 'nxdomain.example.com');
    const resolver = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));

    await expect(domains.verify(tenantId, added.id, resolver)).resolves.toEqual({
      verified: false,
      reason: 'dns_unreachable',
    });
  });

  it('separates "the zone answered with nothing there" from "the lookup failed"', async () => {
    // Different advice: an empty answer means the record name is wrong (or it
    // was never created), and waiting will not fix it. A failed lookup is
    // ordinary propagation.
    const added = await domains.add(tenantId, 'emptyzone.example.com');
    const resolver = vi.fn().mockResolvedValue([]);

    expect(await domains.verify(tenantId, added.id, resolver)).toEqual({
      verified: false,
      reason: 'record_missing',
    });
  });

  it('cannot verify another tenant\'s domain', async () => {
    const { tenantId: otherId } = await signUpWithTenant('domains-other@demo.co', 'owner');
    const foreign = await prisma.tenantDomain.create({
      data: { tenantId: otherId, domain: 'foreign.example.com', isPrimary: false },
    });
    const resolver = vi.fn().mockResolvedValue([[domains.verificationToken(otherId, 'foreign.example.com')]]);

    expect(await domains.verify(tenantId, foreign.id, resolver)).toEqual({
      verified: false,
      reason: 'not_found',
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('issues a STABLE token, so a merchant mid-setup is not handed a new one', async () => {
    const a = domains.verificationToken(tenantId, 'stable.example.com');
    const b = domains.verificationToken(tenantId, 'stable.example.com');
    expect(a).toBe(b);
    // ...and a different one per tenant, so knowing the domain is not enough.
    expect(domains.verificationToken('00000000-0000-0000-0000-000000000000', 'stable.example.com')).not.toBe(a);
  });
});

describe('GET /v1/admin/domains — lo que la UI necesita para dar instrucciones', () => {
  it("returns the platform zone and the tenant's own address to point at", async () => {
    const root = process.env.PLATFORM_ROOT_DOMAIN ?? 'ventia.localhost';
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true } });

    const res = await request(app.getHttpServer()).get('/v1/admin/domains').set('cookie', cookie);

    expect(res.status).toBe(200);
    // The panel used to guess the zone from its own hostname, which is exact
    // only when it is reached at `admin.${root}`.
    expect(res.body.platformRootDomain).toBe(root);
    // The CNAME target is the tenant's free subdomain, NOT whatever is
    // currently primary: `POST /:id/primary` lets a custom domain become
    // primary, and pointing `mitienda.com` at `mitienda.com` is a loop.
    expect(res.body.pointsTo).toBe(`${tenant.slug}.${root}`);
    expect(res.body.verificationHost).toBe('_ventia-verify');
  });

  it('keeps naming the free subdomain even after a custom domain becomes primary', async () => {
    const { cookie: ownCookie, tenantId: ownId } = await signUpWithTenant('domains-points-to@demo.co', 'owner');
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: ownId }, select: { slug: true } });
    const root = process.env.PLATFORM_ROOT_DOMAIN ?? 'ventia.localhost';
    await prisma.tenantDomain.create({
      data: { tenantId: ownId, domain: `${tenant.slug}.${root}`, isPrimary: false, verifiedAt: new Date() },
    });
    await prisma.tenantDomain.create({
      data: { tenantId: ownId, domain: 'promovido.example.com', isPrimary: true, verifiedAt: new Date() },
    });

    const res = await request(app.getHttpServer()).get('/v1/admin/domains').set('cookie', ownCookie);

    expect(res.status).toBe(200);
    expect(res.body.pointsTo).toBe(`${tenant.slug}.${root}`);
    expect(res.body.pointsTo).not.toBe('promovido.example.com');
  });

  it('reports no apex IP rather than inventing one when the operator has not set it', async () => {
    // A wrong A record does not degrade — it takes the merchant's store off
    // the internet. `null` makes the panel ask them to contact support.
    const previous = process.env.PLATFORM_APEX_IP;
    delete process.env.PLATFORM_APEX_IP;
    try {
      const res = await request(app.getHttpServer()).get('/v1/admin/domains').set('cookie', cookie);
      expect(res.body.apexIp).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.PLATFORM_APEX_IP;
      else process.env.PLATFORM_APEX_IP = previous;
    }
  });

  it('returns the apex IP when the operator has set one', async () => {
    const previous = process.env.PLATFORM_APEX_IP;
    process.env.PLATFORM_APEX_IP = '  203.0.113.10  ';
    try {
      const res = await request(app.getHttpServer()).get('/v1/admin/domains').set('cookie', cookie);
      // Trimmed: a stray space pasted into an env file must not reach a DNS
      // panel as part of the address.
      expect(res.body.apexIp).toBe('203.0.113.10');
    } finally {
      if (previous === undefined) delete process.env.PLATFORM_APEX_IP;
      else process.env.PLATFORM_APEX_IP = previous;
    }
  });
});

describe('POST /v1/admin/domains', () => {
  it('registers a domain and returns the record to publish', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/admin/domains')
      .set('cookie', cookie)
      .send({ domain: 'nueva.example.com' });

    expect(res.status).toBe(201);
    expect(res.body.domain).toBe('nueva.example.com');
    expect(res.body.token).toHaveLength(32);
  });

  it('409s a domain another tenant already registered', async () => {
    // `TenantDomain.domain` is what tenant resolution keys on, so reassigning
    // it would redirect a live storefront.
    const { tenantId: otherId } = await signUpWithTenant('domains-taken@demo.co', 'owner');
    await prisma.tenantDomain.create({ data: { tenantId: otherId, domain: 'taken.example.com', isPrimary: false } });

    const res = await request(app.getHttpServer())
      .post('/v1/admin/domains')
      .set('cookie', cookie)
      .send({ domain: 'taken.example.com' });

    expect(res.status).toBe(409);
  });

  it('402s a tenant whose plan excludes custom domains', async () => {
    const { cookie: basicCookie, tenantId: basicId } = await signUpWithTenant('domains-noplan@demo.co', 'owner');
    await prisma.tenantLimits.upsert({
      where: { tenantId: basicId },
      create: { tenantId: basicId, productsMax: 10, aiCreditsMonth: 10, staffSeats: 1, customDomain: false },
      update: { customDomain: false },
    });

    const res = await request(app.getHttpServer())
      .post('/v1/admin/domains')
      .set('cookie', basicCookie)
      .send({ domain: 'noplan.example.com' });

    expect(res.status).toBe(402);
    expect(res.body.error).toBe('PLAN_LIMIT_EXCEEDED');
  });

  it('400s a malformed domain', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/admin/domains')
      .set('cookie', cookie)
      .send({ domain: '*.example.com' });

    expect(res.status).toBe(400);
  });

  it('403s a staff session', async () => {
    const { cookie: staffCookie } = await signUpWithTenant('domains-staff@demo.co', 'staff');
    const res = await request(app.getHttpServer())
      .post('/v1/admin/domains')
      .set('cookie', staffCookie)
      .send({ domain: 'staff.example.com' });

    expect(res.status).toBe(403);
  });
});
