import { Module } from '@nestjs/common';
import { StorefrontCategoriesController } from './categories.controller';
import { StorefrontContentController } from './content.controller';

@Module({
  controllers: [StorefrontCategoriesController, StorefrontContentController],
})
export class StorefrontModule {}
