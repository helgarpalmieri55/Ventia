import { Body, Controller, HttpCode, HttpException, Param, Post, UseGuards } from '@nestjs/common';
import { platformDb, tenantDb } from '@ventia/db';
import { stockAdjustSchema } from '@ventia/core';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession } from '../admin/roles.decorator';
import type { SessionContext } from '../auth/session-context';
import { parseOr400 } from './parse';
import { writeAudit } from './audit';

// AdminSessionGuard rejects any session without a tenantId before a request
// reaches here (see admin-session.guard.ts), so tenantId is guaranteed
// non-null in the handler below.
@Controller('v1/admin/products')
@UseGuards(AdminSessionGuard)
export class StockController {
  @Post(':id/stock')
  @HttpCode(201)
  async adjust(
    @AdminSession() session: SessionContext,
    @Param('id') productId: string,
    @Body() body: unknown,
  ): Promise<{ stock: number }> {
    const input = parseOr400(stockAdjustSchema, body);
    const tenantId = session.tenantId!;
    const db = tenantDb(tenantId);

    const product = await db.product.findFirst({ where: { id: productId }, select: { id: true, stock: true } });
    if (!product) throw new HttpException({ error: 'NOT_FOUND' }, 404);

    let variantId: string | undefined;
    let currentStock = product.stock;

    if (input.variantId) {
      // Must belong to this product (and, via tenantDb's automatic scoping,
      // this tenant) — a variant id from another product/tenant 404s rather
      // than silently adjusting the wrong row.
      const variant = await db.productVariant.findFirst({
        where: { id: input.variantId, productId },
        select: { id: true, stock: true },
      });
      if (!variant) throw new HttpException({ error: 'NOT_FOUND' }, 404);
      variantId = variant.id;
      currentStock = variant.stock;
    }

    const nextStock = currentStock + input.delta;
    if (nextStock < 0) throw new HttpException({ error: 'STOCK_BELOW_ZERO' }, 422);

    // Manual RLS transaction escape (see ProductsService.update after
    // e48e49f): the stock update and its InventoryMovement audit-trail row
    // must commit or roll back together. The tenantDb extension opens a
    // fresh transaction per call, so it can't span both writes atomically —
    // we re-establish RLS scoping (SET LOCAL ROLE + tenant GUC) ourselves for
    // the lifetime of one manual transaction instead.
    await platformDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

      if (variantId) {
        await tx.productVariant.update({ where: { id: variantId }, data: { stock: nextStock } });
      } else {
        await tx.product.update({ where: { id: productId }, data: { stock: nextStock } });
      }
      await tx.inventoryMovement.create({
        data: { tenantId, productId, variantId, delta: input.delta, reason: input.reason, actor: session.userId },
      });
    });

    await writeAudit(session, 'product.stock_adjust', 'Product', productId, input);
    return { stock: nextStock };
  }
}
