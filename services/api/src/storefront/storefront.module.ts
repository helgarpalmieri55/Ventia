import { Module } from '@nestjs/common';
import { StorefrontCategoriesController } from './categories.controller';
import { StorefrontContentController } from './content.controller';
import { StorefrontProductsController } from './products.controller';
import { StorefrontProductsService } from './products.service';

@Module({
  controllers: [StorefrontCategoriesController, StorefrontContentController, StorefrontProductsController],
  providers: [StorefrontProductsService],
})
export class StorefrontModule {}
