# P5 — WhatsApp channel + human handoff (design)

*2026-08-18. Written before implementation, per SPEC.md §11's per-phase loop.*

SPEC.md §7 channel 2, and §11's P5: *"Evolution API (dev) / Cloud API (prod)
integration, number connection flow in admin, message routing, WhatsApp
rendering of tools, Chatwoot escalation, WhatsApp order notifications."*

Everything here is downstream of one fact: **the agent core already exists and
is channel-agnostic.** `AgentService.respond` takes a tenant, a conversation
and a message and returns text plus tool results. P5 is not a second agent —
it is a second transport into the same one, plus a different renderer on the
way out.

---

## 1. Routing: why the webhook URL cannot carry the tenant

Every other webhook in this codebase is `/webhooks/payments/:provider/:tenantId`
— the tenant is in the path, so resolution is free and unambiguous.

WhatsApp cannot work that way, at least not for Cloud API. Meta delivers **one
webhook per app**, covering every phone number registered under that app's
WhatsApp Business Accounts. A single URL therefore receives traffic for every
tenant, and the only thing distinguishing them is inside the payload:

```
entry[0].changes[0].value.metadata.phone_number_id
```

SPEC says exactly this — *"Inbound messages route by phone-number-id →
tenant"* — and it is the reason a new table is needed rather than another key
under `Tenant.settings`: a payload-derived value has to be looked up, so it
must be indexed and globally unique.

```prisma
model WhatsAppNumber {
  id             String   @id @default(uuid()) @db.Uuid
  tenantId       String   @db.Uuid
  provider       WhatsAppProviderId          // evolution | cloud
  // THE routing key. Globally unique, not unique-per-tenant: an inbound
  // delivery carries this and nothing else, so two tenants claiming the same
  // id would make routing ambiguous — and "ambiguous" here means one store's
  // customers talking to another store's agent.
  externalId     String   @unique
  displayPhone   String
  status         String   @default("pending")  // pending | connected | disabled
  credentialsEnc String?                        // AES-256-GCM, same scheme as payments
  verifyToken    String?                        // Meta's hub.verify_token
  ...
}
```

The `@unique` on `externalId` is a real safety property, not tidiness. Without
it a malicious or fat-fingered tenant could register another store's
`phone_number_id` and receive their conversations.

Evolution API is per-instance rather than per-app, so its `externalId` is the
instance name. Same column, same routing, no special case.

## 2. Two providers, one interface

Mirrors `packages/payments` exactly, for the same reasons and with the same
seams:

```ts
export interface WhatsAppProvider {
  readonly id: WhatsAppProviderId;
  verifyAndParseWebhook(raw, headers, config): InboundMessage[] | null;
  sendText(to, body, config, fetchImpl?): Promise<void>;
}
```

- **`fetchImpl` injected**, so adapter tests assert the exact request shape
  without a network — the convention every payment adapter already follows.
- **Verification returns `null` rather than throwing** on an unsigned or
  wrongly-signed payload, so the controller can answer `200` and drop it.
  Meta retries aggressively on non-2xx and a genuinely bogus delivery is not
  something retrying will fix.
- **Parsing returns an ARRAY.** A Cloud API delivery can batch several
  messages in one `changes[]` entry. Returning one message would silently
  drop a shopper's second line.

### Wire formats, read from the docs (SPEC §4: never from memory)

| | Cloud API | Evolution API |
|---|---|---|
| Send | `POST graph.facebook.com/v21.0/{phone_number_id}/messages`, `Authorization: Bearer`, body `{messaging_product, recipient_type, to, type:'text', text:{body}}` | `POST {base}/message/sendText/{instance}`, header `apikey`, body `{number, text}` |
| Inbound | `entry[].changes[].value.messages[]`, text at `.text.body`, sender at `.from` | `data.key.remoteJid` / `data.message.conversation` |
| Signature | `X-Hub-Signature-256: sha256=<hmac-sha256(appSecret, rawBody)>` | shared `apikey`, no per-payload signature |

Two notes on the Evolution shape. Its published examples disagree with each
other about whether the message sits at `data.key` or `data.message.key`, so
the adapter accepts **both** and prefers the flatter one. And `remoteJid`
carries a `@s.whatsapp.net` suffix that is not part of the phone number — it
is stripped on the way in and never stored.

## 3. Rendering: WhatsApp is not the widget

SPEC §7: *"Same agent core, text-first rendering (product lists as numbered
text + short links)"*, and prompt rule 6 already says *"máximo un producto
destacado por mensaje en WhatsApp"*.

The web widget renders product cards from tool results precisely so a
hallucinated price cannot reach a shopper. That guarantee must survive the
channel change, so WhatsApp renders **from the same tool results**, just as
text:

```
1. Camisa Lino Blanca — $120.000
   https://tienda.co/producto/camisa-lino-blanca
```

The price in that line is the tool's number, never a substring of the model's
prose. Same property, different markup.

## 4. What the shopper's identity is

`Conversation.shopperRef` already exists and is `null` for anonymous web
visitors. On WhatsApp it is the sender's phone number — which means a WhatsApp
conversation is inherently identified, and `escalate_to_human`'s email will
carry a real contact rather than "no dejó datos de contacto".

Conversations are looked up by `(tenantId, channel, shopperRef)` rather than by
a cookie. A returning shopper resumes their conversation, which is what
WhatsApp users expect — the thread is the history.

## 5. Plan gate

`TenantLimits.whatsappChannel` already exists. It gates the admin connection
flow AND the inbound path: a delivery for a number whose tenant lost the
entitlement is recorded and dropped, not answered. Otherwise a downgraded
store keeps spending AI budget through a channel it no longer pays for.

## 6. What this phase deliberately does NOT do

- **No template messages in the first slice.** SPEC §6 wants pre-approved
  Cloud API templates for order confirmation/shipped/delivered, "sent only to
  shoppers who provided their number at checkout and ticked consent". There is
  no consent checkbox at checkout today, so shipping the sender without the
  consent it is conditioned on would build the wrong thing. Consent first.
- **Chatwoot is a second notifier, not a replacement.** `escalate_to_human`
  already marks the conversation and emails the merchant (P4d). Chatwoot joins
  that; the email stays, because an owner's inbox is a useful backstop for a
  conversation sitting unread in a helpdesk.
- **No live-API verification.** There is no Meta app or Evolution instance
  available in this environment. Every adapter is written from the official
  docs and tested against recorded payload fixtures; the DoD's "full WhatsApp
  conversation on a test tenant" needs real credentials and is explicitly not
  claimed as done here.

## 7. Slices

| | Scope |
|---|---|
| **P5a** | `packages/whatsapp` — interface, both adapters, fixtures, tests. No DB. |
| **P5b** | `WhatsAppNumber` model + RLS migration, inbound webhook, routing, agent on the `whatsapp` channel, text rendering. |
| **P5c** | Admin connection flow (`/configuracion` → WhatsApp tab): register a number, verify, disable. |
| **P5d** | Chatwoot escalation; checkout consent + template notifications if consent lands in scope. |
