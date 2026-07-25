import { Body, Controller, HttpCode, HttpException, Param, Post, UseGuards } from '@nestjs/common';
import { platformDb, tenantDb } from '@ventia/db';
import { stockAdjustSchema } from '@ventia/core';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, type AdminSessionContext } from '../admin/roles.decorator';
import { parseOr400 } from './parse';
import { writeAudit } from './audit';
import { assertUuidOr404 } from './uuid';

// AdminSessionGuard rejects any session without a tenantId before a request
// reaches here (see admin-session.guard.ts), so tenantId is guaranteed
// non-null in the handler below.
@Controller('v1/admin/products')
@UseGuards(AdminSessionGuard)
export class StockController {
  @Post(':id/stock')
  @HttpCode(201)
  async adjust(
    @AdminSession() session: AdminSessionContext,
    @Param('id') productId: string,
    @Body() body: unknown,
  ): Promise<{ stock: number }> {
    assertUuidOr404(productId);
    const input = parseOr400(stockAdjustSchema, body);
    const tenantId = session.tenantId;
    const db = tenantDb(tenantId);

    const product = await db.product.findFirst({ where: { id: productId }, select: { id: true } });
    if (!product) throw new HttpException({ error: 'NOT_FOUND' }, 404);

    const variantId = input.variantId;
    if (variantId) {
      // Must belong to this product (and, via tenantDb's automatic scoping,
      // this tenant) — a variant id from another product/tenant 404s rather
      // than silently adjusting the wrong row.
      const variant = await db.productVariant.findFirst({ where: { id: variantId, productId }, select: { id: true } });
      if (!variant) throw new HttpException({ error: 'NOT_FOUND' }, 404);
    }

    // Manual RLS transaction escape (see ProductsService.update after
    // e48e49f): the stock update and its InventoryMovement audit-trail row
    // must commit or roll back together. The tenantDb extension opens a
    // fresh transaction per call, so it can't span both writes atomically —
    // we re-establish RLS scoping (SET LOCAL ROLE + tenant GUC) ourselves for
    // the lifetime of one manual transaction instead.
    //
    // The floor check is applied as a single atomic `UPDATE ... SET stock =
    // stock + delta WHERE ... AND stock + delta >= 0 RETURNING stock`,
    // *not* as a separate read-then-write (current stock read above, then an
    // absolute SET below) — two concurrent adjustments that each individually
    // look safe against a stale `currentStock` read can otherwise race into a
    // lost update (whichever transaction commits last silently overwrites the
    // other's decrement, and the floor check itself was validated against a
    // value that's no longer current by the time the write lands). The
    // conditional UPDATE is a single statement, so Postgres's row-level
    // locking makes the read-check-write atomic regardless of transaction
    // isolation level: only one of two racing under-the-floor adjustments can
    // ever succeed, and the other reliably observes 0 rows affected.
    const newStock = await platformDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

      const rows = variantId
        ? await tx.$queryRaw<{ stock: number }[]>`
            UPDATE "ProductVariant" SET stock = stock + ${input.delta}
            WHERE id = ${variantId}::uuid AND "productId" = ${productId}::uuid AND "tenantId" = ${tenantId}::uuid
              AND stock + ${input.delta} >= 0
            RETURNING stock`
        : await tx.$queryRaw<{ stock: number }[]>`
            UPDATE "Product" SET stock = stock + ${input.delta}
            WHERE id = ${productId}::uuid AND "tenantId" = ${tenantId}::uuid
              AND stock + ${input.delta} >= 0
            RETURNING stock`;

      // The pre-checks above already confirmed the row exists and belongs to
      // this tenant/product, so zero rows here means the floor guard
      // rejected the write (the narrow race where the row was deleted
      // between the pre-check and this statement is an accepted edge case,
      // consistent with the same TOCTOU gap in ProductsService.update).
      if (rows.length === 0) throw new HttpException({ error: 'STOCK_BELOW_ZERO' }, 422);

      await tx.inventoryMovement.create({
        data: { tenantId, productId, variantId, delta: input.delta, reason: input.reason, actor: session.userId },
      });

      return rows[0]!.stock;
    });

    await writeAudit(session, 'product.stock_adjust', 'Product', productId, input);
    return { stock: newStock };
  }
}
