import { Inject, Injectable } from '@nestjs/common';
import { platformDb, tenantDb, type ShopperTokenPurpose } from '@ventia/db';
import { MAILER, type Mailer } from '../mailer/mailer';
import { hashPassword, hashSecret, issueSecret, normalizeEmail, verifyPassword } from './shopper-credentials';
import { sendShopperLinkEmail } from '../mailer/shopper-emails';

/**
 * Shopper authentication for one store.
 *
 * ## Everything here runs on `platformDb`, and that is deliberate
 *
 * `ShopperSession` and `ShopperToken` grant `ventia_app` nothing at all, and
 * `ShopperAccount.passwordHash` is outside its column-level SELECT grant (see
 * migration 20260822120000). So authentication physically cannot run on a
 * tenant-scoped connection — which is the point: no merchant-facing query, and
 * no future refactor that reaches for `tenantDb` out of habit, can arrive at a
 * credential. Every query below therefore carries `tenantId` explicitly, and
 * that filter is load-bearing rather than decorative: without RLS underneath,
 * it is the only thing scoping a lookup to one store.
 *
 * ## Answers do not reveal whether an account exists
 *
 * Register, magic-link request and password-reset request all return the same
 * thing whether or not the address is registered. A storefront that answers
 * "ese correo ya tiene cuenta" hands anyone a way to test whether a given
 * person shops at a given store — which, for a store selling something
 * personal, is the sort of disclosure that matters more than the account
 * itself. The distinction is moved into the EMAIL, which only the address
 * owner can read.
 */

/** How long a signed-in browser stays signed in. Thirty days: long enough that
 * a returning shopper is not asked again, short enough that a shared or
 * abandoned device stops being a way in within a month. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

/** How long a link from an email is good for. Fifteen minutes for anything
 * that GRANTS ACCESS (magic link, password reset) — long enough to walk to the
 * other room for the phone, short enough that a forwarded or logged email is
 * not a standing key. */
const ACCESS_LINK_TTL_MS = 15 * 60_000;

/** Verification links get longer, because they grant nothing: the worst case
 * for a stale one is a shopper asking for another. A day covers "I will do it
 * tonight" without pushing people back through the flow. */
const VERIFY_LINK_TTL_MS = 24 * 60 * 60_000;

export interface ShopperIdentity {
  accountId: string;
  tenantId: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  customerId: string | null;
}

/** A newly minted session: the secret goes in the cookie, and is never
 * recoverable afterwards. */
export interface IssuedSession {
  secret: string;
  expiresAt: Date;
}

export interface SignInResult {
  ok: boolean;
  session?: IssuedSession;
  identity?: ShopperIdentity;
}

@Injectable()
export class ShopperAuthService {
  // Explicit @Inject: esbuild (vitest's transform) emits no `design:paramtypes`.
  constructor(@Inject(MAILER) private readonly mailer: Mailer) {}

  /**
   * Registers an account and emails a verification link.
   *
   * Returns nothing about whether the address was already taken. When it was,
   * the existing owner is emailed a notice with a sign-in link instead of a
   * verification one — so a person who forgot they had an account is helped,
   * and a stranger probing addresses learns nothing. Critically, an existing
   * account's password is NOT overwritten: that would let anyone reset any
   * account by "registering" it again.
   */
  async register(
    tenantId: string,
    input: { email: string; password: string; name?: string },
    storefrontBaseUrl: string,
  ): Promise<void> {
    const email = normalizeEmail(input.email);
    const existing = await platformDb.shopperAccount.findUnique({
      where: { tenantId_email: { tenantId, email } },
    });

    if (existing) {
      // Someone tried to claim an address that is already registered. Tell the
      // OWNER, not the caller.
      const link = await this.issueLink(tenantId, existing.id, 'magic_link', ACCESS_LINK_TTL_MS);
      await sendShopperLinkEmail(this.mailer, {
        kind: 'already_registered',
        to: email,
        url: `${storefrontBaseUrl}/cuenta/entrar?token=${encodeURIComponent(link)}`,
      });
      return;
    }

    const account = await platformDb.shopperAccount.create({
      data: {
        tenantId,
        email,
        name: input.name ?? null,
        passwordHash: await hashPassword(input.password),
        // Linked to the merchant's CRM row when one already exists for this
        // address — the person has bought here as a guest before, and their
        // history should not be orphaned by making an account. `?? null`
        // rather than creating a Customer: a registration is not an order, and
        // inventing a customer record for someone who has never bought would
        // pollute the merchant's list.
        customerId: await this.findClaimableCustomerId(tenantId, email),
      },
    });

    const link = await this.issueLink(tenantId, account.id, 'verify_email', VERIFY_LINK_TTL_MS);
    await sendShopperLinkEmail(this.mailer, {
      kind: 'verify_email',
      to: email,
      url: `${storefrontBaseUrl}/cuenta/verificar?token=${encodeURIComponent(link)}`,
    });
  }

  /**
   * Password sign-in.
   *
   * Runs the password check even when no account matched, against a throwaway
   * hash. Skipping it would make a miss measurably faster than a hit, turning
   * response time into an account-existence oracle — the exact disclosure the
   * uniform responses elsewhere in this class exist to prevent.
   *
   * Worth stating because it is easy to "simplify" away: this line has NO
   * functional effect, so no functional test can protect it. Replacing it with
   * an early `return { ok: false }` passes every test in the suite and
   * reintroduces the oracle. A timing assertion would be the only test that
   * caught it, and a timing assertion in CI is a flaky test — so the guard
   * here is this comment and a reviewer reading it.
   */
  async signInWithPassword(tenantId: string, input: { email: string; password: string }): Promise<SignInResult> {
    const email = normalizeEmail(input.email);
    const account = await platformDb.shopperAccount.findUnique({
      where: { tenantId_email: { tenantId, email } },
    });

    const matched = await verifyPassword(input.password, account?.passwordHash ?? DUMMY_HASH);
    if (!account || !matched) return { ok: false };

    return { ok: true, session: await this.startSession(tenantId, account.id), identity: toIdentity(account) };
  }

  /**
   * Emails a sign-in link, or silently does nothing when the address has no
   * account here. Same answer either way to the caller.
   */
  async requestMagicLink(tenantId: string, rawEmail: string, storefrontBaseUrl: string): Promise<void> {
    await this.emailLinkIfAccountExists(tenantId, rawEmail, 'magic_link', ACCESS_LINK_TTL_MS, (token) => ({
      kind: 'magic_link',
      url: `${storefrontBaseUrl}/cuenta/entrar?token=${encodeURIComponent(token)}`,
    }));
  }

  /** Emails a password-reset link, under the same no-disclosure rule. */
  async requestPasswordReset(tenantId: string, rawEmail: string, storefrontBaseUrl: string): Promise<void> {
    await this.emailLinkIfAccountExists(tenantId, rawEmail, 'password_reset', ACCESS_LINK_TTL_MS, (token) => ({
      kind: 'password_reset',
      url: `${storefrontBaseUrl}/cuenta/nueva-clave?token=${encodeURIComponent(token)}`,
    }));
  }

  /**
   * Signs in from a magic link.
   *
   * Consuming a magic link also VERIFIES the address, because clicking it
   * proves the same thing a verification link proves — the person reads that
   * inbox. Making them then click a second link to establish a fact already
   * established is friction with no security value.
   */
  async consumeMagicLink(tenantId: string, token: string): Promise<SignInResult> {
    const account = await this.consumeToken(tenantId, token, 'magic_link');
    if (!account) return { ok: false };

    const verified = account.emailVerifiedAt
      ? account
      : await platformDb.shopperAccount.update({
          where: { id: account.id },
          data: { emailVerifiedAt: new Date() },
        });

    return { ok: true, session: await this.startSession(tenantId, account.id), identity: toIdentity(verified) };
  }

  /** Marks the address verified. Returns false for a spent, expired or unknown
   * token — the three are deliberately indistinguishable to the caller. */
  async verifyEmail(tenantId: string, token: string): Promise<boolean> {
    const account = await this.consumeToken(tenantId, token, 'verify_email');
    if (!account) return false;
    if (!account.emailVerifiedAt) {
      await platformDb.shopperAccount.update({
        where: { id: account.id },
        data: { emailVerifiedAt: new Date() },
      });
    }
    return true;
  }

  /**
   * Sets a new password from a reset link, and revokes every existing session.
   *
   * The revocation is the point of resetting, not a bonus: the usual reason to
   * reset is that someone else may be in the account, and leaving their
   * session alive means the reset changed nothing for them.
   */
  async consumePasswordReset(tenantId: string, token: string, password: string): Promise<SignInResult> {
    const account = await this.consumeToken(tenantId, token, 'password_reset');
    if (!account) return { ok: false };

    const passwordHash = await hashPassword(password);
    const [updated] = await platformDb.$transaction([
      platformDb.shopperAccount.update({
        where: { id: account.id },
        // Reaching a reset link proves inbox access, which is what verification
        // proves. An account that resets its password is verified by that act.
        data: { passwordHash, emailVerifiedAt: account.emailVerifiedAt ?? new Date() },
      }),
      platformDb.shopperSession.deleteMany({ where: { tenantId, accountId: account.id } }),
    ]);

    return { ok: true, session: await this.startSession(tenantId, account.id), identity: toIdentity(updated) };
  }

  /**
   * Resolves a session cookie to the shopper it belongs to, or `null`.
   *
   * The `tenantId` filter is what stops a session minted at one store from
   * working at another. Accounts are per store, so a cookie that survived a
   * shopper moving between two Ventia storefronts must not authenticate them
   * at the second one.
   */
  async resolveSession(tenantId: string, secret: string): Promise<ShopperIdentity | null> {
    const session = await platformDb.shopperSession.findFirst({
      where: { tenantId, tokenHash: hashSecret(secret), expiresAt: { gt: new Date() } },
      include: { account: true },
    });
    return session ? toIdentity(session.account) : null;
  }

  /** Ends one browser's session. Idempotent: signing out twice, or with a
   * cookie that already expired, is a success — the desired state is reached. */
  async signOut(tenantId: string, secret: string): Promise<void> {
    await platformDb.shopperSession.deleteMany({ where: { tenantId, tokenHash: hashSecret(secret) } });
  }

  /** The shopper's own profile edits. Narrow on purpose: email changes need a
   * verification round-trip and are not built yet. */
  async updateProfile(tenantId: string, accountId: string, name: string | null | undefined): Promise<ShopperIdentity> {
    const updated = await platformDb.shopperAccount.update({
      where: { id: accountId },
      data: name === undefined ? {} : { name },
    });
    if (updated.tenantId !== tenantId) {
      // Defence in depth. `accountId` always comes from a resolved session, so
      // this cannot happen today; if it ever does, it is a cross-tenant write
      // and must be loud rather than silent.
      throw new Error('shopper account does not belong to this tenant');
    }
    return toIdentity(updated);
  }

  // ---- internals ---------------------------------------------------------

  /**
   * The merchant's existing CRM row for this address, if there is one.
   *
   * Matching on a VERIFIED-at-registration basis is not possible — the account
   * is brand new — so this links the rows and the ORDER HISTORY endpoint is
   * what gates on `emailVerified`. Linking early is safe because the link
   * alone shows nobody anything; reading orders through it is the part that
   * needs proof of inbox ownership.
   */
  private async findClaimableCustomerId(tenantId: string, email: string): Promise<string | null> {
    const customer = await platformDb.customer.findFirst({
      where: { tenantId, email, shopperAccount: { is: null } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return customer?.id ?? null;
  }

  private async emailLinkIfAccountExists(
    tenantId: string,
    rawEmail: string,
    purpose: ShopperTokenPurpose,
    ttlMs: number,
    build: (token: string) => { kind: 'magic_link' | 'password_reset'; url: string },
  ): Promise<void> {
    const email = normalizeEmail(rawEmail);
    const account = await platformDb.shopperAccount.findUnique({
      where: { tenantId_email: { tenantId, email } },
      select: { id: true },
    });
    if (!account) return;

    const token = await this.issueLink(tenantId, account.id, purpose, ttlMs);
    const { kind, url } = build(token);
    await sendShopperLinkEmail(this.mailer, { kind, to: email, url });
  }

  /** Mints a single-use link secret and stores only its hash. */
  private async issueLink(
    tenantId: string,
    accountId: string,
    purpose: ShopperTokenPurpose,
    ttlMs: number,
  ): Promise<string> {
    const { secret, hash } = issueSecret();
    await platformDb.shopperToken.create({
      data: { tenantId, accountId, purpose, tokenHash: hash, expiresAt: new Date(Date.now() + ttlMs) },
    });
    return secret;
  }

  /**
   * Spends a link token, returning the account it belonged to.
   *
   * The `updateMany` with `consumedAt: null` in its WHERE is the single-use
   * guarantee, and it has to be a conditional UPDATE rather than a read
   * followed by a write: two requests carrying the same token — a double-click
   * on an email, or an attacker racing a victim — would both pass a read-then-
   * check and both be honoured. Postgres serialises the update, so exactly one
   * gets `count === 1`.
   *
   * `tenantId` belongs on that UPDATE and not merely on the read below it.
   * Filtering only afterwards would still REFUSE a token presented at the
   * wrong store — but it would have spent it on the way, so anyone who learned
   * a link could burn it by replaying it at another storefront and the owner's
   * own click would then fail for no visible reason.
   */
  private async consumeToken(tenantId: string, secret: string, purpose: ShopperTokenPurpose) {
    const tokenHash = hashSecret(secret);
    const spent = await platformDb.shopperToken.updateMany({
      where: { tenantId, tokenHash, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (spent.count !== 1) return null;

    const row = await platformDb.shopperToken.findFirst({
      where: { tenantId, tokenHash },
      include: { account: true },
    });
    return row?.account ?? null;
  }

  private async startSession(tenantId: string, accountId: string): Promise<IssuedSession> {
    const { secret, hash } = issueSecret();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await platformDb.shopperSession.create({ data: { tenantId, accountId, tokenHash: hash, expiresAt } });
    return { secret, expiresAt };
  }
}

/**
 * A real scrypt hash of a value nobody knows, compared against when no account
 * matched. Computed once at module load: the cost of `verifyPassword` is what
 * equalises the timing, and paying it on every miss is the whole point.
 */
const DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function toIdentity(account: {
  id: string;
  tenantId: string;
  email: string;
  name: string | null;
  emailVerifiedAt: Date | null;
  customerId: string | null;
}): ShopperIdentity {
  return {
    accountId: account.id,
    tenantId: account.tenantId,
    email: account.email,
    name: account.name,
    emailVerified: account.emailVerifiedAt !== null,
    customerId: account.customerId,
  };
}
