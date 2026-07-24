import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { StorageModule } from '../storage/storage.module';
import { CategoriesController } from './categories.controller';
import { ImagesController } from './images.controller';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { StockController } from './stock.controller';
import { VariantsController } from './variants.controller';

@Module({
  imports: [AdminModule, StorageModule],
  controllers: [CategoriesController, ProductsController, VariantsController, ImagesController, StockController],
  providers: [ProductsService],
})
export class CatalogModule {}
