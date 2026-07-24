// Prisma model names that carry a tenantId column (kept in sync with schema.prisma;
// the RLS migration list is the source of truth for the database layer).
export const TENANT_MODELS: ReadonlySet<string> = new Set([
  'TenantDomain', 'TenantLimits', 'Category', 'Product', 'ProductCategory',
  'ProductVariant', 'ProductImage', 'InventoryMovement', 'Cart', 'CartItem',
  'Customer', 'Order', 'OrderItem', 'OrderEvent', 'Payment', 'Conversation',
  'Message', 'AgentUsage', 'TenantContent', 'NotificationLog', 'Subscription',
  'Shipment', 'Invoice', 'StaffInvite',
]);
