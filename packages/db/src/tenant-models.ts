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
]);
