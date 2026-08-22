import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, type AdminSessionContext } from '../admin/roles.decorator';
import { assertUuidOr404 } from '../catalog/uuid';
import { CollectionsService } from './collections.service';

/**
 * `/v1/admin/collections` — the merchant's curated rows.
 *
 * No `@Roles()`, matching `CategoriesController` and `ProductsController`:
 * arranging the shop window is catalog work, which both admin-portal roles
 * do. `AdminSessionGuard` still rejects any session without a tenant before a
 * request reaches a handler, so `session.tenantId` is non-null throughout.
 *
 * ## The shape of the membership routes, and why there are three
 *
 * A collection's product list is ORDERED, and ordering is the reason the
 * model exists at all (`CollectionProduct.position` in schema.prisma). So the
 * ordering is a first-class request:
 *
 *   PUT    /:id/products              the whole list, in order, atomically
 *   POST   /:id/products              append, without resending the list
 *   DELETE /:id/products/:productId   remove one
 *
 * The PUT is the primitive — every reorder, however the UI expresses it
 * (drag, arrows, a text field), is one PUT of the final array, never N
 * position PATCHes. The other two exist because appending and removing are
 * the two gestures that must NOT depend on the client holding a current copy
 * of the whole list: they are safe from a stale tab, a full replace is not.
 *
 * The collection's own `position` (which strip comes first) is an ordinary
 * field on PATCH instead, because a store has a handful of collections and
 * the merchant edits them one at a time — the N-request problem the PUT
 * solves does not arise at that scale.
 */
@Controller('v1/admin/collections')
@UseGuards(AdminSessionGuard)
export class AdminCollectionsController {
  // Explicit @Inject: esbuild (vitest's TS transform) emits no
  // `design:paramtypes` metadata, so Nest's implicit constructor injection
  // silently leaves the property undefined instead of failing at bootstrap.
  constructor(@Inject(CollectionsService) private readonly collections: CollectionsService) {}

  @Get()
  list(@AdminSession() session: AdminSessionContext) {
    return this.collections.list(session);
  }

  @Post()
  @HttpCode(201)
  create(@AdminSession() session: AdminSessionContext, @Body() body: unknown) {
    return this.collections.create(session, body);
  }

  @Get(':id')
  detail(@AdminSession() session: AdminSessionContext, @Param('id') id: string) {
    assertUuidOr404(id);
    return this.collections.detail(session, id);
  }

  @Patch(':id')
  update(@AdminSession() session: AdminSessionContext, @Param('id') id: string, @Body() body: unknown) {
    assertUuidOr404(id);
    return this.collections.update(session, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@AdminSession() session: AdminSessionContext, @Param('id') id: string): Promise<void> {
    assertUuidOr404(id);
    await this.collections.remove(session, id);
  }

  @Put(':id/products')
  setProducts(@AdminSession() session: AdminSessionContext, @Param('id') id: string, @Body() body: unknown) {
    assertUuidOr404(id);
    return this.collections.setProducts(session, id, body);
  }

  @Post(':id/products')
  @HttpCode(200)
  addProducts(@AdminSession() session: AdminSessionContext, @Param('id') id: string, @Body() body: unknown) {
    assertUuidOr404(id);
    return this.collections.addProducts(session, id, body);
  }

  @Delete(':id/products/:productId')
  @HttpCode(204)
  async removeProduct(
    @AdminSession() session: AdminSessionContext,
    @Param('id') id: string,
    @Param('productId') productId: string,
  ): Promise<void> {
    assertUuidOr404(id);
    assertUuidOr404(productId);
    await this.collections.removeProduct(session, id, productId);
  }
}
