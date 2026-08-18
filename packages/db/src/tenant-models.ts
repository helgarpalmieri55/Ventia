// Prisma model names that carry a tenantId column (kept in sync with schema.prisma;
// the RLS migration list is the source of truth for the database layer).
export const TENANT_MODELS: ReadonlySet<string> = new Set([
  'TenantDomain', 'TenantLimits', 'Category', 'Product', 'ProductCategory',
  'ProductVariant', 'ProductImage', 'InventoryMovement', 'Cart', 'CartItem',
  'Customer', 'Order', 'OrderItem', 'OrderEvent', 'Payment', 'Conversation',
  'Message', 'AgentUsage', 'TenantContent', 'NotificationLog', 'Subscription',
  'Shipment', 'Invoice', 'StaffInvite',
  // READ-ONLY for tenants. `ventia_app` holds SELECT and nothing else on this
  // table, and its RLS policy is `FOR SELECT` only (see
  // 20260815120000_webhook_event_tenant_read) — the sole writer,
  // services/api/src/payments/webhooks.controller.ts, deliberately stays on
  // the owner connection (platformDb). Listing it here is what makes
  // `tenantDb(t).webhookEvent.findMany(...)` inject `AND tenantId = t` at the
  // application layer; RLS enforces the same thing independently at the
  // database layer. `tenantId` is nullable on this model, and a scoped read
  // simply never matches a tenant-less row — correct, since no merchant owns
  // one. A tenantDb WRITE here fails on the missing grant, by design.
  'WebhookEvent',
  // APPEND-ONLY for tenants. `ventia_app` holds SELECT + INSERT and has
  // UPDATE/DELETE revoked, and the RLS policies are `FOR SELECT` / `FOR
  // INSERT` only (see 20260815140000_webhook_event_review). Listing it here
  // injects `AND tenantId = t` on reads and is what makes a tenant-scoped
  // insert carry the right `tenantId`; the database enforces both
  // independently. There is deliberately no code path that updates or
  // deletes one of these rows — an alert marked reviewed by mistake is
  // corrected by APPENDING a `reopened` row, never by rewriting history.
  'WebhookEventReview',
  // READ-ONLY for tenants, and narrower than the rest: `ventia_app` holds a
  // COLUMN-LEVEL SELECT grant that omits `credentialsEnc` and `verifyToken`
  // (see 20260818120000_whatsapp_numbers), with no INSERT/UPDATE/DELETE at
  // all. Listing it here injects `AND tenantId = t` on reads so the
  // application layer agrees with the `FOR SELECT` RLS policy.
  //
  // Consequence worth knowing before you use it: a `tenantDb(t).whatsAppNumber
  // .findMany()` with NO explicit `select` asks for every column, hits the two
  // it may not read, and fails with `permission denied for table
  // WhatsAppNumber` (SQLSTATE 42501). That is the design — it fails loudly
  // rather than loading a Meta access token into application memory. Every
  // real caller today reads through `platformDb` anyway, because the
  // connection flow has to decrypt with the platform key.
  'WhatsAppNumber',
]);
