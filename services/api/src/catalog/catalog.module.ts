import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { CategoriesController } from './categories.controller';

@Module({
  imports: [AdminModule],
  controllers: [CategoriesController],
})
export class CatalogModule {}
