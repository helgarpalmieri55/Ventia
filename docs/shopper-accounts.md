# Shopper accounts

A shopper's login at **one store**. Distinct in every way from the merchant
login, and the differences are deliberate.

|  | Merchant | Shopper |
| --- | --- | --- |
| Tables | better-auth's `User`/`Session`/`Account` | `ShopperAccount`/`ShopperSession`/`ShopperToken` |
| Scope | Platform-wide | One tenant |
| Reachable from tenant code | No — all privileges revoked | Yes, under RLS (except the credential) |
| Cookie | better-auth's | `ventia_shopper` |

---

## 1. Why not reuse better-auth

Migration `20260723205801` revokes ALL privileges on better-auth's tables from
`ventia_app`. That is load-bearing: merchant identity must be unreachable from
tenant-scoped code. Shopper identity is the opposite kind of thing — it *is*
tenant data, the storefront reads it under RLS, and it is scoped per store.
Reusing those tables would mean either reopening the grants or leaving the
storefront unable to read its own users.

## 2. Per store, and why that is a product decision

`ShopperAccount` is `@@unique([tenantId, email])`. The same person shopping at
two Ventia stores has two accounts, with two passwords.

That is not a modelling shortcut. Every generated privacy policy states that
the **merchant** is the *Responsable del Tratamiento* for their own customers
and the platform merely an *Encargado* (`settings/privacy-policy.template.ts`).
A single identity spanning stores would make the platform a controller — needing
its own Ley 1581 authorization in every merchant's policy — and would let
merchant A infer that their customer also shops with merchant B.

The constraint is in the database rather than in a service, so a future write
path cannot forget it.

## 3. The credential is not tenant data, even though the account is

| Table | `ventia_app` holds |
| --- | --- |
| `ShopperAccount` | Column-level SELECT **omitting `passwordHash`**. No writes. |
| `ShopperSession` | Nothing. |
| `ShopperToken` | Nothing. |

So authentication physically cannot run on a tenant-scoped connection, which is
the point: no merchant-facing query — and no future refactor that reaches for
`tenantDb` out of habit — can arrive at a credential. `ShopperAuthService` runs
entirely on `platformDb` and carries `tenantId` explicitly on every query.

A consequence worth knowing: `tenantDb(t).shopperAccount.findMany()` with no
explicit `select` asks for every column, hits `passwordHash`, and fails with
`permission denied` (SQLSTATE 42501). That is the design — it fails loudly
rather than loading credentials into application memory.

## 4. Answers never reveal whether an account exists

Register, magic-link request and password-reset request return **the same
response** whether or not the address is registered. Sign-in returns one error
for a wrong password and an unknown address alike, and runs the password check
even when nothing matched so a miss is not measurably faster than a hit.

A storefront that answers "ese correo ya tiene cuenta" hands anyone a way to
test whether a given person shops at a given store. For a store selling
something personal — a pharmacy, a sex shop, a clinic — that disclosure matters
more than the account itself.

The distinction is moved into the **email**, which only the address owner can
read. Registering with a taken address emails its owner a notice with a sign-in
link, and **does not touch the existing password** — otherwise "register again"
would be an unauthenticated password reset for any address on the platform.

## 5. Links

| Purpose | Lifetime | Grants |
| --- | --- | --- |
| `verify_email` | 24 h | Nothing — worst case is asking for another |
| `magic_link` | 15 min | A session |
| `password_reset` | 15 min | A session, and closes all others |

Only the SHA-256 of each secret is stored, so a database dump yields nothing
presentable as a login. Single use is enforced by a conditional `UPDATE`
(`consumedAt: null` in the WHERE), not a read-then-write: two requests carrying
the same token — a double-click, or an attacker racing a victim — would both
pass a read-then-check.

`tenantId` is on that UPDATE, not merely on the read after it. Filtering only
afterwards would still refuse a link presented at the wrong store, but would
have **spent** it on the way — so anyone who learned a link could burn it by
replaying it elsewhere, and the owner's own click would then fail for no
visible reason.

A password reset deletes every other session for the account. The usual reason
to reset is that someone else may be in there; leaving their session alive means
the reset changed nothing for them.

## 6. Signing in never costs the shopper their basket

A shopper who reaches the payment step, remembers they have an account, signs
in, and finds an empty cart has been handed a reason to abandon at the last
screen. So every route that establishes a session calls
`CartService.mergeOnSignIn` and returns the resulting cart.

**The guest cart wins** — the one the browser is holding, whose contents the
shopper is looking at. The saved cart's lines are folded in and its row is
deleted. Keeping the saved cart instead would swap a basket the shopper can see
for one they cannot, at the exact moment they are deciding whether to pay.

Same product **and** same variant is one line, so quantities add; a different
variant stays a separate line, because someone with a size M saved and a size L
in hand wants both. Quantities are clamped to stock, so the failure does not
reappear at checkout as "your order failed" instead of "we only have two left".

Guest checkout is untouched. An account is an offer, never a gate — requiring
one before a first purchase costs measurable conversion, and for a small
Colombian store that is the difference between a sale and none.

## 7. Order history needs a verified address

The account is linked to a `Customer` by matching email at registration, which
proves nothing on its own: anyone can register with someone else's address. So
`GET /orders` returns 403 `EMAIL_NOT_VERIFIED` until the address is confirmed.
Someone reading a stranger's order history would first have to read the
stranger's email — at which point the order history is the smaller problem.

Linking early is still safe: the link alone shows nobody anything, and reading
through it is the part that is gated.

## 8. Operational notes

- **Rate limit.** `/v1/storefront/account` has its own bucket
  (`RATE_LIMIT_SHOPPER_AUTH_PER_MINUTE`, default 20/min per IP), separate from
  merchant login. Every attempt costs a real scrypt hash, and the link routes
  send mail the platform pays for to an address the requester need not own.
- **Cleanup.** An hourly sweep deletes expired sessions and spent tokens. The
  rows are already inert — every lookup filters on expiry — so this is about
  not keeping credential material whose purpose has been served. Spent tokens
  linger an hour so a double-click can be told apart from a bad link.
- **scrypt needs `maxmem` raised.** N=32768 wants ~33.5 MB and Node's default is
  32 MB; without the explicit override *every* hash throws. It is set in
  `shopper-credentials.ts` — do not "simplify" it away.

## 9. Not built

- **Changing the email on an account.** Needs a verification round-trip to the
  new address before the old one stops working, and nothing depends on it yet.
- **Saved addresses.** The schema has no home for them; checkout still asks
  every time. This is the obvious next thing an account should buy a shopper.
- **Wishlist.** Was one of the three features the accounts decision unblocked;
  it needs its own model.
- **Phone/WhatsApp sign-in.** The right end state for this market — the shopper's
  identity already *is* their number — but WhatsApp credentials are per tenant,
  so it only works for merchants who connected the channel. Email works for
  everyone on day one, and the schema takes a second method without a migration.
