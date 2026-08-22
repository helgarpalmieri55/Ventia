import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { AdminCollectionsController } from './admin-collections.controller';
import { CollectionsService } from './collections.service';
import { StorefrontCollectionsController } from './storefront-collections.controller';

/**
 * Both sides of collections in one module — the admin CRUD and the public
 * read — rather than the storefront half living in `StorefrontModule` next to
 * the categories controller it copies its guard from.
 *
 * The two halves are one feature and they have to agree on a rule that is not
 * written in the schema: which membership rows a shopper may see (active
 * products only, and no empty strips). Splitting them across two modules puts
 * that agreement in two directories, which is how the admin ends up promising
 * a strip the storefront does not draw. `PublicTenantGuard` is imported from
 * `../storefront` because it is a guard, not a module-scoped provider — the
 * same way `CatalogModule` reaches for `revalidateStorefrontTag`.
 *
 * `AdminModule` is imported for `AdminSessionGuard`, matching `CatalogModule`.
 */
@Module({
  imports: [AdminModule],
  controllers: [AdminCollectionsController, StorefrontCollectionsController],
  providers: [CollectionsService],
})
export class CollectionsModule {}
