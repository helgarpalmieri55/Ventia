import { Module } from '@nestjs/common';
import { StorefrontCategoriesController } from './categories.controller';
import { StorefrontContentController } from './content.controller';
import { StorefrontProductsController } from './products.controller';
import { StorefrontProductsService } from './products.service';

@Module({
  controllers: [StorefrontCategoriesController, StorefrontContentController, StorefrontProductsController],
  providers: [StorefrontProductsService],
  // Exported for the agent's `search_products` / `recommend_products` tools,
  // which must run the SAME search a shopper gets on the storefront rather
  // than a second implementation that could rank or filter differently.
  exports: [StorefrontProductsService],
})
export class StorefrontModule {}
