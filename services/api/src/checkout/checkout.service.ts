import { HttpException, Inject, Injectable } from '@nestjs/common';
import { Prisma, platformDb, type TaxRate as PrismaTaxRate } from '@ventia/db';
import type { CheckoutAddressInput, TaxRateValue } from '@ventia/core';
import { ShippingService } from './shipping.service';
import { nextOrderNumber } from './order-number';

// Same DB-enum <-> human-string maps as cart.service.ts / storefront/products.service.ts
// / csv-import.service.ts (duplicated locally, matching this codebase's
// established per-module-copy convention for these small const tables).
const TAX_RATE_FROM_DB: Record<PrismaTaxRate, TaxRateValue> = {
  ZERO: '0',
  FIVE: '5',
  NINETEEN: '19',
  EXCLUIDO: 'excluido',
};

const TAX_RATE_TO_DB: Record<TaxRateValue, PrismaTaxRate> = {
  '0': 'ZERO',
  '5': 'FIVE',
  '19': 'NINETEEN',
  excluido: 'EXCLUIDO',
};

const TAX_RATE_DECIMAL: Record<TaxRateValue, number> = {
  '0': 0,
  '5': 0.05,
  '19': 0.19,
  excluido: 0,
};

export interface CheckoutInput {
  email: string;
  phone: string;
  address: CheckoutAddressInput; // from @ventia/core — already validated by the controller before this service is called
  shippingMethodId: string;
  paymentMethod: 'cod';
}

export interface CheckoutResult {
  orderNumber: number;
  totalCents: number;
}

interface CheckoutLine {
  productId: string;
  variantId: string | null;
  qty: number;
  name: string;
  priceCents: number;
  taxRate: TaxRateValue;
}

@Injectable()
export class CheckoutService {
  // Explicit @Inject: esbuild (vitest's TS transform) doesn't emit
  // `design:paramtypes` metadata, so Nest's implicit constructor-injection by
  // type alone can't resolve ShippingService here — same caution as every
  // other controller/service in this codebase (see cart.controller.ts).
  constructor(@Inject(ShippingService) private readonly shippingService: ShippingService) {}

  async checkout(tenantId: string, cartCookieKey: string, input: CheckoutInput): Promise<CheckoutResult> {
    const result = await platformDb.$transaction(
      async (tx) => {
        // Manual RLS transaction escape (same pattern as
        // storefront/products.service.ts's list() and csv-import.service.ts's
        // commit()): allocating a sequential per-tenant order number needs a
        // Postgres advisory lock, which is raw SQL — and tenantDb's Prisma
        // extension deliberately blocks raw queries (see
        // packages/db/src/tenant-client.ts). We re-establish RLS scoping
        // ourselves for the lifetime of this one transaction; every
        // read/write below uses `tx` directly (NOT tenantDb) and explicitly
        // includes tenantId in every where/data, with Postgres RLS as the
        // fail-closed backstop if that's ever missed.
        await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        // Advisory lock taken up front (inside nextOrderNumber) serializes
        // concurrent checkouts for this SAME tenant for the rest of this
        // transaction's lifetime — see order-number.ts's doc comment.

        const cart = await tx.cart.findFirst({
          where: { tenantId, cookieKey: cartCookieKey },
          include: { items: true },
        });
        if (!cart || cart.items.length === 0) {
          throw new HttpException({ error: 'CART_EMPTY' }, 400);
        }

        // Re-fetch every line's CURRENT product/variant state — checkout
        // must never trust the cart's possibly-stale price/stock snapshot.
        const productIds = [...new Set(cart.items.map((i) => i.productId))];
        const variantIds = [
          ...new Set(cart.items.map((i) => i.variantId).filter((v): v is string => v !== null)),
        ];
        const [products, variants] = await Promise.all([
          tx.product.findMany({ where: { tenantId, id: { in: productIds } } }),
          variantIds.length
            ? tx.productVariant.findMany({ where: { tenantId, id: { in: variantIds } } })
            : Promise.resolve([]),
        ]);
        const productById = new Map(products.map((p) => [p.id, p]));
        const variantById = new Map(variants.map((v) => [v.id, v]));

        let subtotalCents = 0;
        let taxCents = 0;
        const lines: CheckoutLine[] = [];

        for (const item of cart.items) {
          const product = productById.get(item.productId);
          // A product removed/archived since it was added to the cart has no
          // meaningful "available" count to report — treat as 0 available,
          // same bucket as a genuine stock shortfall (INSUFFICIENT_STOCK),
          // since the underlying customer-facing problem is identical: this
          // line can no longer be fulfilled. This throw aborts the whole
          // $transaction callback, so Prisma rolls back everything already
          // written above (nothing is written above at this point, but later
          // lines/order/customer rows would be too) — no partial order.
          if (!product) {
            throw new HttpException(
              { error: 'INSUFFICIENT_STOCK', details: { productId: item.productId, available: 0 } },
              400,
            );
          }
          const variant = item.variantId ? variantById.get(item.variantId) : undefined;
          if (item.variantId && !variant) {
            throw new HttpException(
              { error: 'INSUFFICIENT_STOCK', details: { productId: item.productId, available: 0 } },
              400,
            );
          }

          // ProductVariant has no `trackInventory` flag of its own (schema.prisma) —
          // it always defers to the parent product's flag, only substituting
          // its own `stock` count when a variant is selected.
          const stock = variant ? variant.stock : product.stock;
          if (product.trackInventory && stock < item.qty) {
            throw new HttpException(
              { error: 'INSUFFICIENT_STOCK', details: { productId: item.productId, available: stock } },
              400,
            );
          }

          const priceCents = variant?.priceCents ?? product.priceCents;
          const taxRate = TAX_RATE_FROM_DB[product.taxRate];
          const lineSubtotalCents = priceCents * item.qty;
          const rateDecimal = TAX_RATE_DECIMAL[taxRate];
          const lineTaxCents = lineSubtotalCents - Math.round(lineSubtotalCents / (1 + rateDecimal));
          subtotalCents += lineSubtotalCents;
          taxCents += lineTaxCents;

          lines.push({
            productId: item.productId,
            variantId: item.variantId,
            qty: item.qty,
            name: product.name,
            priceCents,
            taxRate,
          });
        }

        // ShippingService's methods run on plain tenantDb (each a read of
        // Tenant.settings, committed independently of this transaction) —
        // calling them from inside our transaction is safe since they don't
        // need transactional consistency with the order write below, and
        // they never touch Cart/Order/Customer rows themselves.
        const codAllowed = await this.shippingService.isCodAllowed(tenantId, input.address.departamentoCode);
        if (!codAllowed) {
          throw new HttpException({ error: 'SHIPPING_METHOD_UNAVAILABLE' }, 400);
        }

        const shippingCents = await this.shippingService.priceFor(
          tenantId,
          input.shippingMethodId,
          input.address.departamentoCode,
          subtotalCents,
        );

        const totalCents = subtotalCents + taxCents + shippingCents;
        const orderNumber = await nextOrderNumber(tx, tenantId);

        const existingCustomer = await tx.customer.findFirst({ where: { tenantId, email: input.email } });
        const customer = existingCustomer
          ? await tx.customer.update({
              where: { id: existingCustomer.id },
              data: { ordersCount: { increment: 1 }, totalSpentCents: { increment: totalCents } },
            })
          : await tx.customer.create({
              data: {
                tenantId,
                email: input.email,
                phone: input.phone,
                name: input.address.nombreCompleto,
                ordersCount: 1,
                totalSpentCents: totalCents,
              },
            });

        const order = await tx.order.create({
          data: {
            tenantId,
            number: orderNumber,
            status: 'PENDING',
            paymentStatus: 'COD',
            customerId: customer.id,
            email: input.email,
            phone: input.phone,
            shippingAddress: input.address as Prisma.InputJsonValue,
            shippingMethod: input.shippingMethodId,
            shippingCents,
            subtotalCents,
            taxCents,
            totalCents,
            source: 'web',
          },
        });

        await Promise.all(
          lines.map((line) =>
            tx.orderItem.create({
              data: {
                tenantId,
                orderId: order.id,
                productId: line.productId,
                variantId: line.variantId,
                nameSnapshot: line.name,
                priceCentsSnapshot: line.priceCents,
                qty: line.qty,
                taxRateSnapshot: TAX_RATE_TO_DB[line.taxRate],
              },
            }),
          ),
        );

        await tx.orderEvent.create({
          data: { tenantId, orderId: order.id, type: 'created', actor: 'shopper' },
        });

        // Cascades to CartItem via the schema's onDelete: Cascade.
        await tx.cart.delete({ where: { id: cart.id } });

        return { orderNumber, totalCents };
      },
      { timeout: 15_000 },
    );

    // Task 5 wires in the post-checkout email flow HERE, after the
    // transaction has committed — a fire-and-forget call to
    // services/api/src/mailer/order-emails.ts's sendOrderEmails(...), NOT
    // awaited, wrapped in its own .catch(console.error), so a slow/failed
    // email send can never delay or fail the checkout response itself. Not
    // implemented in this task (Task 4) — order creation only.

    return result;
  }
}
