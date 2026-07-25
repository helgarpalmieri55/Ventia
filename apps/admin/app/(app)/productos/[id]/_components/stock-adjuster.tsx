'use client';

import { useState } from 'react';
import { stockAdjustSchema } from '@ventia/core';
import { Alert, Button, FormField, Input, Select } from '@ventia/ui';
import { ApiError, apiFetch } from '../../../../../lib/api';
import { errorMessage } from '../../../../../lib/errors';
import { STOCK_REASON_LABELS, type StockAdjustReason } from '../../../../../lib/product-labels';
import type { ProductVariant } from './product-types';

const REASON_OPTIONS: StockAdjustReason[] = ['restock', 'manual_adjust', 'correction'];
const PRODUCT_TARGET = 'product';

export type StockAdjustTarget = { type: 'product' } | { type: 'variant'; variantId: string };

export interface StockAdjusterProps {
  productId: string;
  productStock: number;
  variants: ProductVariant[];
  onAdjusted: (result: { stock: number }, target: StockAdjustTarget) => void;
}

/** Section 4 of the edit page: a delta + reason form that posts to
 * `POST .../stock`, which is the ONLY way to change stock after a product
 * is created (see `productUpdateSchema`'s comment on why `stock` isn't
 * PATCHable) — every change here writes an audited `InventoryMovement` row
 * server-side. When the product has variants, an extra "target" select
 * chooses between the base product's own stock and one specific variant's;
 * with no variants, the target is implicitly the product. */
export function StockAdjuster({ productId, productStock, variants, onAdjusted }: StockAdjusterProps) {
  const [target, setTarget] = useState<string>(PRODUCT_TARGET);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState<StockAdjustReason>('restock');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const selectedVariant = target === PRODUCT_TARGET ? null : variants.find((v) => v.id === target) ?? null;
  const currentStock = selectedVariant ? selectedVariant.stock : productStock;

  async function handleSubmit() {
    setError(null);
    const deltaTrim = delta.trim();
    const deltaNumber = deltaTrim === '' ? Number.NaN : Number(deltaTrim);

    const raw = {
      variantId: target === PRODUCT_TARGET ? undefined : target,
      delta: deltaNumber,
      reason,
    };
    const parsed = stockAdjustSchema.safeParse(raw);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Revisa el ajuste de inventario.');
      return;
    }

    setSubmitting(true);
    try {
      const result = await apiFetch<{ stock: number }>(`/v1/admin/products/${productId}/stock`, {
        method: 'POST',
        body: JSON.stringify(parsed.data),
      });
      onAdjusted(result, selectedVariant ? { type: 'variant', variantId: selectedVariant.id } : { type: 'product' });
      setDelta('');
    } catch (e) {
      setError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-foreground">
        Stock actual{selectedVariant ? ` (variante seleccionada)` : ''}: <span className="font-medium">{currentStock}</span>
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {variants.length > 0 ? (
          <FormField label="Objetivo" htmlFor="stock-target">
            <Select value={target} onChange={(event) => setTarget(event.target.value)}>
              <option value={PRODUCT_TARGET}>Producto (sin variante)</option>
              {variants.map((variant) => {
                const label = [variant.option1, variant.option2, variant.option3].filter(Boolean).join(' / ');
                return (
                  <option key={variant.id} value={variant.id}>
                    {label || variant.sku || variant.id}
                  </option>
                );
              })}
            </Select>
          </FormField>
        ) : null}
        <FormField label="Cambio (+/-)" htmlFor="stock-delta">
          <Input type="number" step="1" value={delta} onChange={(event) => setDelta(event.target.value)} />
        </FormField>
        <FormField label="Motivo" htmlFor="stock-reason">
          <Select value={reason} onChange={(event) => setReason(event.target.value as StockAdjustReason)}>
            {REASON_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {STOCK_REASON_LABELS[value]}
              </option>
            ))}
          </Select>
        </FormField>
      </div>

      {error ? <Alert variant="error">{error}</Alert> : null}

      <Button disabled={submitting} className="self-start" onClick={() => void handleSubmit()}>
        {submitting ? 'Ajustando…' : 'Ajustar stock'}
      </Button>
    </div>
  );
}
