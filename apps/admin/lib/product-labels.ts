import type { TaxRateValue } from '@ventia/core';

/** es-CO copy for each `productInputSchema.taxRate` value (`TAX_RATES` in
 * `@ventia/core`). */
export const TAX_RATE_LABELS: Record<TaxRateValue, string> = {
  '0': 'Sin IVA (0%)',
  '5': 'IVA 5%',
  '19': 'IVA 19%',
  excluido: 'Excluido',
};

export type ProductStatus = 'draft' | 'active' | 'archived';

/** es-CO copy for `productInputSchema.status`, matching the labels already
 * used by `productos/page.tsx`'s list/filter. */
export const STATUS_LABELS: Record<ProductStatus, string> = {
  draft: 'Borrador',
  active: 'Activo',
  archived: 'Archivado',
};

export type StockAdjustReason = 'restock' | 'manual_adjust' | 'correction';

/** es-CO copy for `stockAdjustSchema.reason` (`@ventia/core`). */
export const STOCK_REASON_LABELS: Record<StockAdjustReason, string> = {
  restock: 'Reabastecimiento',
  manual_adjust: 'Ajuste manual',
  correction: 'Corrección',
};
