import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Prisma, tenantDb } from '@ventia/db';
import { categoryInputSchema, slugify } from '@ventia/core';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, type AdminSessionContext } from '../admin/roles.decorator';
import { parseOr400 } from './parse';
import { writeAudit } from './audit';
import { assertUuidOr404 } from './uuid';
import { revalidateStorefrontTag } from '../storefront/revalidate';
import { rejectCategoryParent } from './category-tree';

const categoryUpdateSchema = categoryInputSchema.partial();

function isUniqueConstraintError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function isNotFoundError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

// AdminSessionGuard rejects any session without a tenantId before a request
// reaches here (see admin-session.guard.ts: `!session.tenantId` -> 403), so
// tenantId is guaranteed non-null in every handler below.
@Controller('v1/admin/categories')
@UseGuards(AdminSessionGuard)
export class CategoriesController {
  @Get()
  async list(@AdminSession() session: AdminSessionContext) {
    return tenantDb(session.tenantId).category.findMany({
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
  }

  /**
   * Validates a proposed parent against the tenant's current tree, throwing
   * the HTTP error it deserves.
   *
   * The existence check is deliberately its own query rather than trust in the
   * foreign key: Postgres does not apply row-level security to foreign key
   * checks, so a `parentId` copied from another store's category would satisfy
   * the constraint and quietly link the two tenants' trees together. Reading it
   * through `tenantDb` is what makes a foreign id a 404.
   *
   * `categoryId` is `null` on create — see `rejectCategoryParent`.
   */
  private async assertParentAllowed(
    tenantId: string,
    categoryId: string | null,
    parentId: string,
  ): Promise<void> {
    const db = tenantDb(tenantId);
    const parent = await db.category.findFirst({ where: { id: parentId, tenantId }, select: { id: true } });
    if (!parent) throw new HttpException({ error: 'PARENT_NOT_FOUND' }, 404);

    const nodes = await db.category.findMany({ where: { tenantId }, select: { id: true, parentId: true } });
    const rejection = rejectCategoryParent(nodes, categoryId, parentId);
    if (rejection) throw new HttpException({ error: rejection }, 400);
  }

  @Post()
  async create(@AdminSession() session: AdminSessionContext, @Body() body: unknown) {
    const input = parseOr400(categoryInputSchema, body);
    const slug = input.slug ?? slugify(input.name);
    if (input.parentId) await this.assertParentAllowed(session.tenantId, null, input.parentId);

    try {
      const category = await tenantDb(session.tenantId).category.create({
        data: {
          tenantId: session.tenantId,
          name: input.name,
          slug,
          position: input.position ?? 0,
          parentId: input.parentId ?? null,
        },
      });
      await writeAudit(session, 'category.create', 'Category', category.id, input);
      revalidateStorefrontTag(`categories:${session.tenantId}`);
      return category;
    } catch (err) {
      if (isUniqueConstraintError(err)) throw new HttpException({ error: 'SLUG_TAKEN' }, 409);
      throw err;
    }
  }

  @Patch(':id')
  async update(@AdminSession() session: AdminSessionContext, @Param('id') id: string, @Body() body: unknown) {
    assertUuidOr404(id);
    const input = parseOr400(categoryUpdateSchema, body);
    // `input.parentId` is falsy for both "not sent" and an explicit `null`,
    // and neither needs checking: leaving the parent alone cannot break the
    // tree, and promoting a category to a root can only make it shallower.
    if (input.parentId) await this.assertParentAllowed(session.tenantId, id, input.parentId);

    try {
      const category = await tenantDb(session.tenantId).category.update({
        where: { id },
        data: input,
      });
      await writeAudit(session, 'category.update', 'Category', category.id, input);
      revalidateStorefrontTag(`categories:${session.tenantId}`);
      return category;
    } catch (err) {
      if (isNotFoundError(err)) throw new HttpException({ error: 'NOT_FOUND' }, 404);
      if (isUniqueConstraintError(err)) throw new HttpException({ error: 'SLUG_TAKEN' }, 409);
      throw err;
    }
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@AdminSession() session: AdminSessionContext, @Param('id') id: string): Promise<void> {
    assertUuidOr404(id);
    try {
      await tenantDb(session.tenantId).category.delete({ where: { id } });
    } catch (err) {
      if (isNotFoundError(err)) throw new HttpException({ error: 'NOT_FOUND' }, 404);
      throw err;
    }
    // Products are untouched by this delete: only the ProductCategory join
    // rows cascade (see schema.prisma's `onDelete: Cascade` on that relation).
    await writeAudit(session, 'category.delete', 'Category', id);
    revalidateStorefrontTag(`categories:${session.tenantId}`);
  }
}
