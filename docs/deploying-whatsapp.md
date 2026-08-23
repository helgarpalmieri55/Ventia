# Connecting a Meta WhatsApp app

> Recording the Meta App Review screencasts? Start from
> [`docs/grabacion-app-review.md`](grabacion-app-review.md) (Spanish) instead — it
> covers the public tunnel, what to paste where, and the screencast script.
> This document is the deploy-time reference it builds on.

Written for the deploy where a real Meta app exists. Everything in
`packages/whatsapp/src/cloud.ts` was built from Meta's published docs and
tested against the payload examples in those docs — **not** against live
traffic. This document is the shortest path to closing that gap, and it is
deliberately blunt about which assumptions are most likely to be the ones that
break first.

---

## 1. What is per-deployment vs per-tenant

Almost nothing is per-deployment. WhatsApp credentials live **per tenant**, in
`WhatsAppNumber`, encrypted with `PAYMENTS_ENCRYPTION_KEY`. A merchant connects
their own number through **Configuración → WhatsApp** in the admin.

The one platform-level decision is made in the Meta dashboard, not in env: which
Meta app the numbers sit under. That choice matters because **one app delivers
one webhook covering every number registered under it** — which is why routing
keys off `phone_number_id` inside the payload rather than off the URL, and why
`WhatsAppNumber.externalId` is globally unique.

## 2. Per number, in the Meta dashboard

For each merchant's number you need four values, all pasted into the admin form:

| Admin field | Where it comes from |
|---|---|
| Phone number ID | WhatsApp → API Setup. The numeric id, **not** the phone number |
| Access token | A **System User** token, not the 24-hour temporary one |
| App secret | App Settings → Basic → App Secret |
| Verify token | You invent it. Any random string; paste the same value into Meta |

Then set the callback URL. The admin shows the exact string with a copy button —
use that rather than assembling it by hand:

```
https://<your-api-host>/webhooks/whatsapp/cloud?number=<phone-number-id>
```

Subscribe the app to the **`messages`** webhook field. Nothing else is read.

## 3. Verify in this order

Each step isolates one failure, so a break tells you where it is.

1. **Handshake.** Save the callback URL in Meta. A green tick means the GET
   handshake matched your verify token. A failure here is either a wrong token
   or the `?number=` param not surviving — see risk 1 below.
2. **Inbound reaches us.** Send a message to the number from a personal phone.
   Check **Conversaciones** in the admin: a row should appear with your number
   as the contact. If nothing appears, the API log will say why — the endpoint
   answers 200 to everything, so absence of a row is the signal, not an error
   response.
3. **Signature.** If step 2 produced nothing, the most likely cause is a wrong
   app secret: an unverifiable payload is dropped silently on purpose (a 4xx
   would make Meta retry a delivery that can never become valid).
4. **Outbound.** The agent's reply goes back through the Cloud API. A failure
   here logs `cloud sendText failed: HTTP …`, and the status distinguishes an
   expired token (401) from a number that is not on WhatsApp (400).

## 4. Where I would expect the first breakage

Ordered by how likely they are to bite, not by severity.

**1 — The `?number=` query parameter on the callback URL.** This is *our*
invention, not something Meta specifies. Meta's GET handshake sends only
`hub.mode`, `hub.challenge` and `hub.verify_token`, with nothing identifying
which number is being verified, so the parameter is how the endpoint knows whose
verify token to compare against. If Meta strips or rejects a query string in the
callback URL, **the handshake cannot be attributed and step 1 fails**. The fix is
small and localised: `verify()` in `whatsapp-webhooks.controller.ts` would
instead try the supplied token against every configured number and accept a
match. That is slightly weaker (it reveals that *some* tenant holds that token)
but perfectly workable. This is the single most likely thing to need changing.

**2 — The pinned Graph version.** `GRAPH_VERSION = 'v21.0'` in `cloud.ts`, pinned
deliberately so Meta's deprecation schedule cannot change behaviour without a
deploy. If your app is newer, bump it — one constant, one line.

**3 — `pushName` coming back empty.** The sender's display name is matched by
`contacts[].wa_id === messages[].from`. If Meta formats those two fields
differently, the match silently fails and the name is simply absent. Harmless —
it is display-only and never used for routing — but it will look like a bug.

**4 — The 24-hour customer service window.** Meta only permits free-form
messages within 24 hours of the customer's last message; outside it you must use
an approved template. Every reply the agent sends is a direct response to an
inbound message, so it is always inside the window. This becomes relevant only
when order notifications ship (see below), which is exactly why they are not
built yet.

## 5. What is deliberately not built

**Template notifications** for order confirmed / shipped / delivered. SPEC §6
conditions them on shoppers who "provided their number at checkout and ticked
consent", and there is no consent checkbox at checkout today. Building the
sender before the consent it is conditioned on would be building the wrong
thing — and under Ley 1581 the consent is the part that actually matters.

**Evolution API** is the development provider and is wired but equally
unverified. It is not a production path: it drives a personal WhatsApp session
rather than the Business Platform.

## 6. What holds regardless of any of the above

These are enforced server-side and do not depend on the wire format being right:

- A delivery whose `phone_number_id` is not this number's is ignored, so one
  Meta app serving many tenants cannot cross-deliver.
- An unsigned or wrongly-signed payload is dropped; a missing app secret fails
  closed rather than open.
- Retries are deduped by `Message.externalId`, so a redelivery cannot become a
  second billed model call.
- The plan gate is re-checked on **every** inbound message, so a downgraded
  store stops answering even though Meta keeps delivering.
- The agent's monthly budget cap and per-conversation throttle apply identically
  to WhatsApp and to the web widget — it is one agent with two transports.
