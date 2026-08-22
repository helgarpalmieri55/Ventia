import { describe, expect, it } from 'vitest';
import {
  DOMAIN_STATE_BADGE,
  DOMAIN_STATE_LABEL,
  INVALID_DOMAIN_MESSAGE,
  addDomainFieldError,
  canBecomePrimary,
  domainState,
  domainStateExplanation,
  isPlatformDomain,
  normalizeDomainInput,
  primaryChangeConsequences,
  storefrontUrl,
  verificationHelp,
  verificationRecord,
  type DomainState,
  type TenantDomain,
} from '../lib/domains-api';

/** A row exactly as `GET /v1/admin/domains` returns it (see
 * `CustomDomainsService#listForTenant`). */
function row(overrides: Partial<TenantDomain> = {}): TenantDomain {
  return {
    id: 'dom_1',
    domain: 'mitienda.com',
    isPrimary: false,
    verified: false,
    token: 'a'.repeat(32),
    ...overrides,
  };
}

/** The address every store gets at onboarding: inside the platform zone,
 * verified at creation (`onboarding.service.ts` writes `verifiedAt` in the
 * same statement), primary until the merchant promotes something else. */
const platformSub = row({ id: 'dom_sub', domain: 'demo-moda.ventia.co', isPrimary: true, verified: true });

describe('normalizeDomainInput', () => {
  // Mirrors `normalizeDomain` in custom-domains.service.ts, case for case with
  // that module's own tests — this preview must not accept something the
  // server rejects, nor reject something it accepts.
  it('strips what a merchant realistically pastes', () => {
    expect(normalizeDomainInput('  HTTPS://Tienda.Example.COM/algo  ')).toBe('tienda.example.com');
    expect(normalizeDomainInput('tienda.example.com.')).toBe('tienda.example.com');
    expect(normalizeDomainInput('tienda.example.com:443')).toBe('tienda.example.com');
  });

  it('rejects the values the server rejects', () => {
    expect(normalizeDomainInput('*.example.com')).toBeNull();
    expect(normalizeDomainInput('localhost')).toBeNull(); // single label
    expect(normalizeDomainInput('-bad.example.com')).toBeNull();
    expect(normalizeDomainInput('exa mple.com')).toBeNull();
    expect(normalizeDomainInput('')).toBeNull();
    expect(normalizeDomainInput(null)).toBeNull();
  });
});

describe('isPlatformDomain', () => {
  it('matches the zone and its subdomains', () => {
    expect(isPlatformDomain('demo-moda.ventia.co', 'ventia.co')).toBe(true);
    expect(isPlatformDomain('ventia.co', 'ventia.co')).toBe(true);
  });

  it('does NOT match a lookalike domain', () => {
    // Same bug the server guards against in `isPlatformSubdomain`: without the
    // dot in the suffix test, someone who registered `evilventia.co` would be
    // told their store is already served there for free.
    expect(isPlatformDomain('evilventia.co', 'ventia.co')).toBe(false);
    expect(isPlatformDomain('ventia.co.attacker.net', 'ventia.co')).toBe(false);
  });

  it('matches nothing when the zone is unknown', () => {
    expect(isPlatformDomain('mitienda.com', null)).toBe(false);
  });
});

describe('domainState', () => {
  const enabled = { customDomainEnabled: true, platformRoot: 'ventia.co' };
  const emprende = { customDomainEnabled: false, platformRoot: 'ventia.co' };

  it('keeps the platform subdomain working on a plan without custom domains', () => {
    // `emprende.customDomain` is false, and the store's own subdomain is the
    // ONLY address it has. The TLS gate exempts our own zone for exactly this
    // reason (isDomainAllowed condition 4); telling a emprende merchant their
    // store address needs a better plan would be false and alarming.
    expect(domainState(platformSub, emprende)).toBe('platform');
    expect(domainState(platformSub, enabled)).toBe('platform');
  });

  it('answers with the PLAN before the DNS work, not after', () => {
    // The whole point of showing plan state on this page: a `emprende` merchant
    // told "pending, publish this TXT record" spends an afternoon in their
    // registrar's panel for a certificate we were never going to issue.
    expect(domainState(row({ verified: false }), emprende)).toBe('blocked_by_plan');
    expect(domainState(row({ verified: true }), emprende)).toBe('blocked_by_plan');
  });

  it('separates "waiting on DNS" from "serving"', () => {
    expect(domainState(row({ verified: false }), enabled)).toBe('pending');
    expect(domainState(row({ verified: true }), enabled)).toBe('active');
  });

  it('does not call a domain ours just because it is primary', () => {
    // Before `POST /:id/primary`, `isPrimary` implied the platform subdomain.
    // It no longer does, and reading it that way would tell a merchant their
    // freshly promoted domain needs no setup.
    const promoted = row({ domain: 'mitienda.com', isPrimary: true, verified: true });
    expect(domainState(promoted, enabled)).toBe('active');
    expect(domainState(promoted, emprende)).toBe('blocked_by_plan');
  });

  it('never calls an UNVERIFIED domain ours, whatever its name looks like', () => {
    // The safety net under a misderived zone: every platform subdomain is
    // created already verified, so an unverified row is always the merchant's
    // own work-in-progress.
    const unverifiedInZone = row({ domain: 'otra.ventia.co', verified: false });
    expect(domainState(unverifiedInZone, enabled)).toBe('pending');
  });

  it('has a label, a badge and an explanation for every state', () => {
    const states: DomainState[] = ['platform', 'blocked_by_plan', 'pending', 'active'];
    for (const state of states) {
      expect(DOMAIN_STATE_LABEL[state]).toBeTruthy();
      expect(DOMAIN_STATE_BADGE[state]).toBeTruthy();
      expect(domainStateExplanation(state).length).toBeGreaterThan(20);
    }
    // The two that mean "your store does NOT answer here" must say so.
    expect(domainStateExplanation('blocked_by_plan')).toContain('no responde');
    expect(domainStateExplanation('pending')).toContain('no responde');
  });
});

describe('verificationRecord', () => {
  it('builds the record from the host the API sent, never from a local copy', () => {
    const record = verificationRecord(row({ domain: 'mitienda.com', token: 'abc123' }), '_ventia-verify');
    expect(record).toEqual({
      type: 'TXT',
      name: '_ventia-verify.mitienda.com',
      host: '_ventia-verify',
      domain: 'mitienda.com',
      value: 'abc123',
    });
  });

  it('shows the same value on every render, because the token is derived server-side', () => {
    const domain = row({ token: 'stable-token' });
    expect(verificationRecord(domain, '_ventia-verify').value).toBe(
      verificationRecord(domain, '_ventia-verify').value,
    );
  });
});

describe('verificationHelp', () => {
  const record = verificationRecord(row({ domain: 'mitienda.com', token: 'tok' }), '_ventia-verify');

  it('treats a first unreachable lookup as propagation and says only that', () => {
    const help = verificationHelp('dns_unreachable', 1, record);
    expect(help.headline).toContain('_ventia-verify.mitienda.com');
    expect(help.checks).toEqual([]);
    expect(help.footnote).toContain('volver más tarde');
  });

  it('names every cause once the lookup keeps failing', () => {
    const help = verificationHelp('dns_unreachable', 2, record);
    const checks = help.checks.join(' ');
    expect(checks).toContain('_ventia-verify.mitienda.com.mitienda.com'); // the doubled name
    expect(checks).toContain('tok'); // the value to compare against
    expect(checks).toContain('TXT'); // the record type
    expect(help.checks.length).toBeGreaterThanOrEqual(3);
  });

  it('does not tell the merchant to wait when the record is simply absent', () => {
    // The zone answered. Waiting is not the fix — the record name is — so the
    // very first failure gets the full checklist rather than "es lo normal".
    const help = verificationHelp('record_missing', 1, record);
    expect(help.checks.length).toBeGreaterThanOrEqual(3);
    expect(help.checks.join(' ')).toContain('_ventia-verify.mitienda.com.mitienda.com');
    expect(help.footnote).not.toContain('volver más tarde');
  });

  it('points at the value, and only the value, on a mismatch', () => {
    // The merchant published something. Repeating the whole checklist here —
    // or telling them to wait — sends them to re-check things that are already
    // right. This is the case the old bare-boolean API could not distinguish.
    const help = verificationHelp('record_mismatch', 1, record);
    expect(help.headline).toContain('otro valor');
    expect(help.checks.join(' ')).toContain('tok');
    expect(help.checks.join(' ')).not.toContain('TXT. Un registro A');
    expect(help.footnote).toContain('No hace falta esperar');
  });

  it('never claims a mismatch the API did not report', () => {
    // An older API sends no reason at all. The copy must stay at "we do not
    // see it", which is a statement about us, rather than asserting the value
    // is wrong.
    for (const attempts of [1, 2, 7]) {
      const help = verificationHelp(undefined, attempts, record);
      expect(help.headline).toMatch(/(no vemos|sin encontrar)/);
    }
    expect(verificationHelp('dns_unreachable', 5, record).headline).not.toContain('otro valor');
  });
});

describe('storefrontUrl', () => {
  it('links a real domain over https', () => {
    // The direction that matters: a domain this app has never seen gets https,
    // so a merchant is never handed a plaintext link to their live store.
    expect(storefrontUrl('mitienda.com')).toBe('https://mitienda.com');
    expect(storefrontUrl('demo-moda.ventia.co')).toBe('https://demo-moda.ventia.co');
  });

  it('links the dev stack over http, where no certificate can exist', () => {
    // `.localhost` is reserved (RFC 6761) and docker/Caddyfile serves it on
    // plain HTTP, so this can never downgrade a registrable name.
    expect(storefrontUrl('demo-moda.ventia.localhost')).toBe('http://demo-moda.ventia.localhost');
    expect(storefrontUrl('tienda.local')).toBe('http://tienda.local');
    expect(storefrontUrl('tienda.test')).toBe('http://tienda.test');
  });
});

describe('canBecomePrimary', () => {
  it('offers the action on a domain that actually serves', () => {
    expect(canBecomePrimary(row({ verified: true }), 'active')).toBe(true);
    // Going back to the Ventia address is a legitimate move too.
    expect(canBecomePrimary(row({ domain: 'demo.ventia.co', verified: true }), 'platform')).toBe(true);
  });

  it('never offers it for the domain that already is primary', () => {
    expect(canBecomePrimary(row({ isPrimary: true, verified: true }), 'active')).toBe(false);
  });

  it('never offers it for an unverified domain', () => {
    // The API refuses with 409 DOMAIN_NOT_VERIFIED; the page does not present
    // a button whose only outcome is that error.
    expect(canBecomePrimary(row({ verified: false }), 'pending')).toBe(false);
  });

  it('never offers it for a domain the plan does not cover', () => {
    // The API WOULD promote this one (it only checks `verifiedAt`), and that
    // is exactly why the UI must not offer it: the TLS gate refuses that
    // domain a certificate, so every WhatsApp link the agent then sent a
    // shopper would land on a certificate error.
    expect(canBecomePrimary(row({ verified: true }), 'blocked_by_plan')).toBe(false);
  });
});

describe('primaryChangeConsequences', () => {
  it('names every place the merchant\'s CUSTOMERS will see the address change', () => {
    const lines = primaryChangeConsequences('mitienda.com', 'demo-moda.ventia.co').join(' ');
    expect(lines).toContain('WhatsApp');
    expect(lines).toContain('política de tratamiento de datos');
    // The terms name the domain too (`terms.service.ts` reads the primary row
    // exactly as the privacy policy does), and used to go unmentioned.
    expect(lines).toContain('términos y condiciones');
  });

  it('does not claim a published document rewrites itself', () => {
    // Both documents are generated and then PUBLISHED as stored text. Saying
    // the address "pasa a ser" the new one would tell a merchant their live
    // legal pages already updated, when what actually changed is the next
    // regeneration.
    const lines = primaryChangeConsequences('mitienda.com', 'demo-moda.ventia.co').join(' ');
    expect(lines).toContain('no cambian solos');
  });

  it('says the old address keeps working, because that is the scary reading', () => {
    // True: the demoted row keeps its `verifiedAt`, and the TLS gate never
    // consults `isPrimary`.
    const lines = primaryChangeConsequences('mitienda.com', 'demo-moda.ventia.co');
    expect(lines.some((line) => line.includes('demo-moda.ventia.co') && line.includes('sigue funcionando'))).toBe(true);
  });

  it('omits that reassurance when there is no current primary to keep', () => {
    expect(primaryChangeConsequences('mitienda.com', null)).toHaveLength(2);
  });
});

describe('addDomainFieldError', () => {
  it('reads the API\'s real 400 shape, which is not zod\'s', () => {
    // custom-domains.controller.ts answers
    // `{ error: 'VALIDATION_FAILED', details: { domain: 'dominio inválido' } }`
    // — no `fieldErrors`, so `fieldErrors()` from lib/errors.ts finds nothing
    // and the merchant would get "Revisa los campos marcados" with no field
    // marked.
    expect(addDomainFieldError({ code: 'VALIDATION_FAILED', details: { domain: 'dominio inválido' } })).toBe(
      INVALID_DOMAIN_MESSAGE,
    );
  });

  it('leaves every other error to the shared mapping', () => {
    expect(addDomainFieldError({ code: 'PLAN_LIMIT_EXCEEDED', details: { feature: 'customDomain' } })).toBeNull();
    expect(addDomainFieldError({ code: 'DOMAIN_ALREADY_REGISTERED', details: undefined })).toBeNull();
    expect(addDomainFieldError({ code: 'VALIDATION_FAILED', details: { fieldErrors: { otro: ['x'] } } })).toBeNull();
  });
});
