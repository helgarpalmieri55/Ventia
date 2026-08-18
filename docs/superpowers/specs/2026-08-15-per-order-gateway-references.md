# Per-order gateway references (closing the cross-tenant settle collision)

**Status:** implemented. **Scope:** `Order.reference`, the three payment
adapters, the webhook settle path, the reconciliation worker.

## The hole

Two Ventia tenants are explicitly allowed to share ONE gateway merchant
account (see `webhooks.controller.ts`'s fix-4 note, and the tenant-scoped
idempotency key that exists because of it). Sharing an account means sharing
its `eventsSecret`, so one signed delivery verifies at *either* tenant's
webhook URL. For ePayco the confirmation URL is account-wide and configured
out of band in their dashboard, so deliveries for both tenants genuinely
arrive at one configured endpoint.

`Order.number` is per-tenant (`@@unique([tenantId, number])`), so order
`1001` exists in both tenants. Until now the gateway reference WAS that
number, and the handler resolved it against the tenant named in the URL path.
So a delivery about tenant B's order 1001, arriving at tenant A's URL,
resolved to tenant A's order 1001.

What stopped that becoming a wrong settle was the unconditional amount check:
`event.amountCents === order.totalCents`. That is a real guard and it holds —
right up until the two same-numbered orders have the same total. Two stores
selling the same item at the same price is not an exotic coincidence; it is
what a shared account looks like in the cases where sharing is attractive
(one operator, several storefronts, overlapping catalogue).

The failure is the worst shape this system has: tenant A's order settles from
tenant B's shopper's money. B's shopper is charged and has no order; A ships
goods nobody paid them for.

## Why the amount check could not be made to carry this

Adding `paymentProvider` or a stricter amount comparison does not help — both
orders are on the same provider, and the amounts are equal *by assumption* in
the failing case. The reference itself has to identify the order globally
rather than only within a tenant. No amount of checking downstream of an
ambiguous identifier resolves the ambiguity.

## The change

`Order.reference` — a globally unique, random, unguessable string, generated
at order creation and sent to the gateway as the reference. The handler
resolves it globally and then asserts the resolved order belongs to the
tenant in the URL.

That single assertion is what closes it: a delivery about B's order now
resolves to **B's order** wherever it is POSTed, and if the URL says tenant A,
the mismatch is a rejection rather than a settle.

Three properties, each load-bearing:

- **Globally unique.** `@unique` on the column, not `@@unique([tenantId, …])`.
  Cross-tenant ambiguity is precisely the bug; scoping the constraint by
  tenant would preserve it.
- **Random, not derived.** Not `{tenantSlug}-{number}` or a truncated tenant
  UUID. A derived reference is guessable, and a guessable reference lets an
  attacker who can reach a webhook endpoint name an order that is not theirs.
  For ePayco this matters concretely: `x_extra1` is not covered by the
  confirmation hash, so the value is attacker-supplied until the gateway's own
  lookup corroborates it. Unguessable means a forged reference does not name
  anything.
- **Opaque to the merchant.** `Order.number` stays exactly as it was — the
  human-facing `VNT-1001` a merchant and shopper see everywhere. The reference
  is plumbing; nothing renders it.

### Why not just put the tenant id in the reference

`{tenantId}-{number}` would also let the handler detect the mismatch, and was
the first idea. It is worse on two counts: it is guessable (above), and it
leaks the tenant's internal id into a string that ends up in a third party's
dashboard, logs and emails. A random token carries no information at all,
which is the right amount for an identifier whose only job is to be matched.

### Transitional acceptance of numeric references

A gateway session created BEFORE this change sent the numeric reference, and
its webhook may arrive after the deploy. Rejecting those would strand exactly
the shopper this codebase works hardest to protect — mid-payment, money taken,
no order.

So a purely numeric reference is still accepted, resolved as an order number
scoped to the URL tenant, i.e. the old behaviour with the old (amount-check)
guarantee. This window closes on its own: every affected order is inside its
15-minute stock hold, so nothing older than that can still be legitimately
in flight. The branch is marked for removal, and the new references are not
numeric (they are base32 with a `vr_` prefix), so the two can never be
confused for one another.

## What this does NOT fix

A delivery for tenant B POSTed to tenant A's URL is now *rejected*, not
*routed to B*. That is correct — this handler's contract is "settle an order
of the tenant in the URL" — but it means a misconfigured account-wide
confirmation URL still fails to settle one tenant's orders. That is a
configuration problem with a loud, visible failure (`order_not_found` rows and
a reconciliation sweep that eventually recovers the order), which is a
categorically better place to be than a silent wrong settle.
