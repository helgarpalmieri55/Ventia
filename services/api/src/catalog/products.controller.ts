import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession } from '../admin/roles.decorator';
import type { SessionContext } from '../auth/session-context';
import { ProductsService, type ProductListQuery } from './products.service';
import { assertUuidOr404 } from './uuid';

// AdminSessionGuard rejects any session without a tenantId before a request
// reaches here (see admin-session.guard.ts: `!session.tenantId` -> 403), so
// tenantId is guaranteed non-null in every handler below. No @Roles() is set
// on this controller: both 'owner' and 'staff' may manage products.
@Controller('v1/admin/products')
@UseGuards(AdminSessionGuard)
export class ProductsController {
  // Explicit @Inject: esbuild (vitest's default TS transform) does not emit
  // TypeScript's `design:paramtypes` decorator metadata, so Nest's implicit
  // constructor-injection cannot resolve ProductsService by type alone (same
  // caution as admin-session.guard.ts's Reflector/AuthInstance injection).
  constructor(@Inject(ProductsService) private readonly products: ProductsService) {}

  @Get()
  async list(@AdminSession() session: SessionContext, @Query() query: ProductListQuery) {
    return this.products.list(session, query);
  }

  @Post()
  @HttpCode(201)
  async create(@AdminSession() session: SessionContext, @Body() body: unknown) {
    return this.products.create(session, body);
  }

  @Get(':id')
  async findOne(@AdminSession() session: SessionContext, @Param('id') id: string) {
    assertUuidOr404(id);
    return this.products.findOne(session, id);
  }

  @Patch(':id')
  async update(@AdminSession() session: SessionContext, @Param('id') id: string, @Body() body: unknown) {
    assertUuidOr404(id);
    return this.products.update(session, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async archive(@AdminSession() session: SessionContext, @Param('id') id: string): Promise<void> {
    assertUuidOr404(id);
    await this.products.archive(session, id);
  }
}
