import { Body, Controller, HttpException, Inject, Param, Put, UseGuards } from '@nestjs/common';
import { Prisma, platformDb, tenantDb } from '@ventia/db';
import { variantsReplaceSchema } from '@ventia/core';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, type AdminSessionContext } from '../admin/roles.decorator';
import { parseOr400 } from './parse';
import { writeAudit } from './audit';
import { ProductsService } from './products.service';
import { assertUuidOr404 } from './uuid';

function isNotFoundError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

// AdminSessionGuard rejects any session without a tenantId before a request
// reaches here (see admin-session.guard.ts), so tenantId is guaranteed
// non-null in the handler below.
@Controller('v1/admin/products')
@UseGuards(AdminSessionGuard)
export class VariantsController {
  // Explicit @Inject: esbuild (vitest's default TS transform) does not emit
  // TypeScript's `design:paramtypes` decorator metadata, so Nest's implicit
  // constructor-injection cannot resolve ProductsService by type alone (same
  // caution as admin-session.guard.ts's Reflector/AuthInstance injection).
  constructor(@Inject(ProductsService) private readonly products: ProductsService) {}

  @Put(':id/variants')
  async replace(@AdminSession() session: AdminSessionContext, @Param('id') id: string, @Body() body: unknown) {
    assertUuidOr404(id);
    const input = parseOr400(variantsReplaceSchema, body);
    const tenantId = session.tenantId;
    const db = tenantDb(tenantId);

    const existing = await db.product.findFirst({ where: { id }, select: { id: true } });
    if (!existing) throw new HttpException({ error: 'NOT_FOUND' }, 404);

    try {
      // Manual RLS transaction escape (see ProductsService.update after
      // e48e49f): the tenantDb extension opens a fresh transaction per call,
      // so it can't span "delete the existing variant set, create the new
      // one, and set product.options" as a single atomic unit. We
      // re-establish RLS scoping (SET LOCAL ROLE + tenant GUC) ourselves for
      // the lifetime of one manual transaction; Postgres RLS still enforces
      // every statement below.
      await platformDb.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

        await tx.productVariant.deleteMany({ where: { productId: id, tenantId } });
        if (input.variants.length) {
          await tx.productVariant.createMany({
            data: input.variants.map((v) => ({ ...v, tenantId, productId: id })),
          });
        }
        await tx.product.update({ where: { id }, data: { options: input.options } });
      });
    } catch (err) {
      if (isNotFoundError(err)) throw new HttpException({ error: 'NOT_FOUND' }, 404);
      throw err;
    }

    await writeAudit(session, 'product.variants_replace', 'Product', id, input);
    return this.products.findOne(session, id);
  }
}
