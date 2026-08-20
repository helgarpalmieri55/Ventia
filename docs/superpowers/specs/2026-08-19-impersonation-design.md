# Operator impersonation (design)

*2026-08-19. Written before implementation, per SPEC.md §11's per-phase loop.*

SPEC.md §6 (M9) asks for it in one clause:

> Tenants: list, search, detail … suspend/reactivate, **impersonate (banner
> shown, every action audit-logged)**.

with an acceptance criterion in the same section:

> **AC:** impersonation sessions expire in 30 min and are visually
> unmistakable.

Everything else in P6 shipped without a design doc. This did not, and was
deferred twice on purpose: impersonation is the one feature in this codebase
that deliberately crosses the tenant boundary the entire architecture exists to
hold. Postgres RLS, `tenantDb`, the column-level grants, the isolation suite —
all of it assumes no principal ever legitimately acts inside a tenant that is
not theirs. Impersonation is that principal. It has to be designed, not
discovered.

---

## 1. The decision that determines everything else

**Whose identity does an impersonated request carry?**

There are two answers and they are not close.

### Rejected — mint a session AS the merchant

The obvious implementation: the operator clicks *Impersonar*, the server
creates a `Session` row for the merchant's `User`, hands the operator that
cookie, and every downstream request is indistinguishable from the merchant's
own.

It is indistinguishable from the merchant's own. That is the whole problem.

- **The audit trail becomes a lie.** `writeAudit` records `session.userId`.
  Every action the operator takes is then attributed, in the permanent record,
  to the merchant. Not "unattributed" — *misattributed*, which is worse: the
  merchant's own audit log now asserts they did something they did not do, and
  there is no field that says otherwise. SPEC's "every action audit-logged" is
  satisfied on a technicality and defeated in substance.
- **It creates a real credential.** A minted session cookie for the merchant's
  account is a full account takeover in a browser's cookie jar, in a log, in a
  screenshot. Its blast radius is not "an operator looked at a store"; it is
  "someone holds the merchant's account".
- **It cannot be revoked distinctly.** The row looks like any other session, so
  "end all impersonation now" means either knowing which rows were minted or
  logging every merchant out.

### Chosen — the operator stays themselves, and borrows a scope

The operator's own session is never replaced. A separate, short-lived,
server-signed **grant** says: *this operator may act within tenant X until
time T*. `getSessionContext` keeps returning the operator's `userId` and adds
the granted `tenantId`.

```
SessionContext {
  userId:     <operator's own id>      // unchanged, always
  tenantId:   <the impersonated tenant>
  role:       'owner'                  // see §4
  impersonation: { operatorId, tenantId, expiresAt }   // present only when acting
}
```

Consequences, all of them good:

- `writeAudit` already writes `session.userId`, so **every audit row names the
  operator**, with no change to any call site. The merchant's log shows a
  Ventia operator acting in their store, which is exactly what happened.
- There is no merchant credential anywhere. Stealing the grant gets you what
  the operator had, for at most thirty minutes, against one named tenant.
- Revocation is deleting one thing that is *only* used for this.

Everything below follows from this choice.

---

## 2. Where the grant lives

**A separate cookie holding a signed, self-expiring token — not a column on
`Session`, and not a row.**

A column on `Session` would mean the impersonation state rides on the
operator's long-lived session, so a bug that fails to clear it leaves the
operator silently inside someone's store on their next login a week later.
Expiry would be a comparison someone has to remember to write.

A signed token expires *by construction*: past `exp` it does not verify, and no
code path can forget to check because verification is the only way to read it.
Sign with `AUTH_SECRET` (already required, already the trust root for
better-auth). Payload is exactly:

```
{ op: <operatorUserId>, ten: <tenantId>, exp: <issued + 30 min> }
```

`op` is in the payload and **must be compared against the live session on every
request**. A grant is only valid for the operator it was issued to — otherwise
a leaked token is a bearer token for someone else's store. This is the check
that turns "signed" into "bound".

The cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` outside dev —
matching what `test/session-cookie.test.ts` already pins for the session
cookie, and for the same reasons.

**Thirty minutes is a hard ceiling, not a sliding window.** No refresh, no
extend-on-activity. SPEC says sessions *expire in 30 min*; a sliding window
would mean an operator who leaves a tab open is inside a merchant's store
indefinitely. Ending and re-entering costs one click and produces a second
audit record, which is a feature.

---

## 3. Issuing it

`POST /v1/platform/tenants/:id/impersonate`, behind `PlatformAdminGuard` —
which already requires the `PLATFORM_ADMIN_EMAILS` allowlist **and**
`User.isPlatformAdmin` **and** a verified email. No new access control is
invented here; impersonation is simply another thing only an operator can do.

The issuing request itself writes a platform audit row (`platform-audit.ts`)
before the token is returned. If the audit write fails, no token is issued.
An impersonation that is not recorded must not happen — that ordering is the
difference between an audit trail and a best-effort log.

`DELETE` on the same path clears the cookie. The UI calls it on *Salir*, and
the token expiring on its own is the backstop rather than the mechanism.

---

## 4. What an operator may do inside a store

This is the part where it is tempting to ship "full access, it's audited" and
be done. That is wrong, and the reason is not caution — it is that some actions
are **not reversible by the audit trail**.

An audit row is a remedy for *"who did this?"*. It is no remedy at all for an
action whose effect has already left the building. Three categories, and they
must be refused during impersonation regardless of what the audit log would
say:

1. **Irreversible destruction of a third party's rights.**
   `POST /v1/admin/customers/:id/anonymize`. The Ley 1581 flow is deliberately
   one-way — it rewrites PII in place and cannot be undone. An operator must
   never be able to trigger a shopper's *supresión* while wearing a merchant's
   face, and the merchant must never have to explain to the SIC an
   anonymization they did not request.

2. **Anything that emails or messages a real customer.** Order transitions send
   shopper-facing mail; the WhatsApp channel sends messages. Those land in a
   stranger's inbox signed by the merchant's store. An audit row does not
   unsend them.

3. **Credential and identity surfaces.** Payment provider keys, WhatsApp
   credentials, staff invites, custom domains. Reading a merchant's decrypted
   gateway keys is not "support"; writing a staff invite is minting a
   persistent membership that outlives the thirty minutes and the audit trail's
   usefulness.

**Mechanism: an allow-list, not a deny-list.** A deny-list is wrong for the
same reason it is always wrong here — every future endpoint is permitted by
default, and the failure is silent. The default for an impersonated request is
**deny on writes**, with specific, enumerated read and write routes opted in.
Concretely: reads are broadly available (that is what support needs — see the
store as the merchant sees it), writes start at zero.

If that turns out to be too narrow in the pilot, widening it is a reviewed,
one-line-per-route decision with a name attached. Narrowing a deny-list after a
leak is not.

---

## 5. Making it unmistakable

SPEC's AC is *visually unmistakable*, and the failure mode it guards against is
specific: an operator forgets they are impersonating, treats the store as a
demo, and changes something real.

Two rules:

- **The banner's source of truth is the server.** `GET /v1/admin/me` reports
  the impersonation context; the admin shell renders the banner from that
  response, never from a client-side flag or a route param. A UI that decides
  for itself whether it is impersonating can be wrong; one that reports what
  the API just told it cannot be more wrong than the API.
- **It cannot be dismissed, and it displaces rather than overlays.** A closable
  banner is a banner that is closed. It occupies layout at the top of every
  page, names the store, shows the remaining time, and holds the *Salir* button
  — so the way out is always in the same place as the reminder.

The countdown is not decoration: an operator who can see four minutes left does
not start a long task.

---

## 6. What this does NOT change

`tenantDb(tenantId)` still sets `app.tenant_id` and `SET LOCAL ROLE
ventia_app`, so **Postgres RLS still constrains every impersonated query to the
granted tenant**. Impersonation widens *which* tenant an operator may name; it
does not weaken the mechanism that keeps a request inside the tenant it named.
An operator with a grant for tenant X who somehow induced a query for tenant Y
would be stopped by the same policy that stops a merchant. That property is
free, and it is the reason this design is safe to build at all.

The `role` in the borrowed context is `'owner'`, because support questions are
about things only an owner can see. It is not a membership — no `Membership`
row is created, read, or implied — which keeps `getSessionContext`'s
"deliberately independent of Membership" posture intact and means an
impersonation can never be mistaken for a staff seat, or count against one.

---

## 7. Tests this needs before it is real

Stated up front so implementation is not graded on its own homework:

- A grant issued for operator A **rejected** when presented with operator B's
  session, and when presented with no session.
- A grant for tenant X rejected on a request that resolves tenant Y.
- Expiry enforced at 31 minutes; no sliding window (a request at minute 29 does
  not extend the deadline).
- A non-operator cannot obtain a grant — including a user on the env allowlist
  whose `isPlatformAdmin` is false, and a verified operator with the allowlist
  unset.
- **Every write performed under impersonation records the operator's `userId`,
  not the merchant's** — the property the whole design exists for.
- Each refused category from §4 refused, with the anonymize endpoint asserted
  by name.
- The banner data comes from the API response and is present whenever, and only
  whenever, a valid grant is.

Each of these should be mutation-tested: break the check, watch that specific
test go red, revert. The `op`-binding check in §2 and the operator-attribution
assertion above are the two that matter most — if either passes with the code
broken, this feature is not built.

---

## 8. Deliberately out of scope

- **Impersonating a specific staff member.** Only the tenant is named, and the
  role is always `owner`. Choosing a user would mean the grant names a person,
  which drifts back toward "acting as them".
- **Shopper-side impersonation** (viewing the storefront as a customer). The
  storefront is public; there is nothing to impersonate.
- **Self-service by the merchant** ("grant support access for 24h"). A better
  consent story and worth building later, but it is a different feature with a
  different threat model, and SPEC asks for the operator-initiated one.
