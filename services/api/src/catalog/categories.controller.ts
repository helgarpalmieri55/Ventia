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
import { AdminSession } from '../admin/roles.decorator';
import type { SessionContext } from '../auth/session-context';
import { parseOr400 } from './parse';
import { writeAudit } from './audit';
import { assertUuidOr404 } from './uuid';

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
  async list(@AdminSession() session: SessionContext) {
    return tenantDb(session.tenantId!).category.findMany({
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
  }

  @Post()
  async create(@AdminSession() session: SessionContext, @Body() body: unknown) {
    const input = parseOr400(categoryInputSchema, body);
    const slug = input.slug ?? slugify(input.name);

    try {
      const category = await tenantDb(session.tenantId!).category.create({
        data: {
          tenantId: session.tenantId!,
          name: input.name,
          slug,
          position: input.position ?? 0,
        },
      });
      await writeAudit(session, 'category.create', 'Category', category.id, input);
      return category;
    } catch (err) {
      if (isUniqueConstraintError(err)) throw new HttpException({ error: 'SLUG_TAKEN' }, 409);
      throw err;
    }
  }

  @Patch(':id')
  async update(@AdminSession() session: SessionContext, @Param('id') id: string, @Body() body: unknown) {
    assertUuidOr404(id);
    const input = parseOr400(categoryUpdateSchema, body);

    try {
      const category = await tenantDb(session.tenantId!).category.update({
        where: { id },
        data: input,
      });
      await writeAudit(session, 'category.update', 'Category', category.id, input);
      return category;
    } catch (err) {
      if (isNotFoundError(err)) throw new HttpException({ error: 'NOT_FOUND' }, 404);
      if (isUniqueConstraintError(err)) throw new HttpException({ error: 'SLUG_TAKEN' }, 409);
      throw err;
    }
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@AdminSession() session: SessionContext, @Param('id') id: string): Promise<void> {
    assertUuidOr404(id);
    try {
      await tenantDb(session.tenantId!).category.delete({ where: { id } });
    } catch (err) {
      if (isNotFoundError(err)) throw new HttpException({ error: 'NOT_FOUND' }, 404);
      throw err;
    }
    // Products are untouched by this delete: only the ProductCategory join
    // rows cascade (see schema.prisma's `onDelete: Cascade` on that relation).
    await writeAudit(session, 'category.delete', 'Category', id);
  }
}
