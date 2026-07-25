import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { StorageModule } from '../storage/storage.module';
import { CsvImportController } from '../csv-import/csv-import.controller';
import { CsvImportService } from '../csv-import/csv-import.service';
import { CategoriesController } from './categories.controller';
import { ImagesController } from './images.controller';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { StockController } from './stock.controller';
import { VariantsController } from './variants.controller';

// CsvImportController/Service (Task 8) are registered here rather than in
// their own CsvImportModule: the whole feature is just another catalog
// entry point over the same Product/Category/ProductImage models the rest
// of this module already owns, and it reuses ProductsService's sibling
// helpers directly (plan-limits.ts, audit.ts) — a separate module would only
// add an import edge back to this one for no isolation benefit.
@Module({
  imports: [AdminModule, StorageModule],
  controllers: [
    CategoriesController,
    ProductsController,
    VariantsController,
    ImagesController,
    StockController,
    CsvImportController,
  ],
  providers: [ProductsService, CsvImportService],
})
export class CatalogModule {}
