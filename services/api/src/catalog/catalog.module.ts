import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { CategoriesController } from './categories.controller';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

@Module({
  imports: [AdminModule],
  controllers: [CategoriesController, ProductsController],
  providers: [ProductsService],
})
export class CatalogModule {}
