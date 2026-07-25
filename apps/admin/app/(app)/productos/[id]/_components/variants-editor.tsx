'use client';

import { useState } from 'react';
import { variantsReplaceSchema } from '@ventia/core';
import { Alert, Button, Input, Table, Tbody, Td, Th, Thead, Tr } from '@ventia/ui';
import { buildVariantsPayload, type VariantRowInput } from '../../../../../lib/variants';
import { ApiError, apiFetch } from '../../../../../lib/api';
import { errorMessage } from '../../../../../lib/errors';
import { centsToPesos } from '../../../../../lib/format';
import type { Product, ProductVariant } from './product-types';

const MAX_LABELS = 3;

function emptyRow(): VariantRowInput {
  return { values: ['', '', ''], priceCentsPesos: '', sku: '', stock: '' };
}

function initLabels(options: string[]): string[] {
  const labels = options.slice(0, MAX_LABELS);
  while (labels.length < MAX_LABELS) labels.push('');
  return labels;
}

function initRows(variants: ProductVariant[]): VariantRowInput[] {
  if (variants.length === 0) return [emptyRow()];
  return variants.map((v) => ({
    values: [v.option1 ?? '', v.option2 ?? '', v.option3 ?? ''],
    priceCentsPesos: v.priceCents != null ? String(centsToPesos(v.priceCents)) : '',
    sku: v.sku ?? '',
    stock: String(v.stock),
  }));
}

export interface VariantsEditorProps {
  productId: string;
  options: string[];
  variants: ProductVariant[];
  onUpdate: (updated: Product) => void;
}

/** Section 2 of the edit page: up to 3 option-label inputs (the table's
 * column headers below) plus a table of variant rows — one row per
 * combination the merchant wants to sell, each with a value per label, an
 * optional pesos override price, sku, and stock. `buildVariantsPayload`
 * (lib/variants.ts) turns this raw form state into the `PUT .../variants`
 * body, filtering blank labels/rows. Saving always replaces the product's
 * *entire* variant set (`variantsReplaceSchema`'s semantics: delete-all,
 * insert-the-given-set) — existing variant identities (ids) are not
 * preserved across a save, which is why the warning below is shown
 * unconditionally rather than only on some "destructive" subset of edits. */
export function VariantsEditor({ productId, options, variants, onUpdate }: VariantsEditorProps) {
  const [labels, setLabels] = useState<string[]>(() => initLabels(options));
  const [rows, setRows] = useState<VariantRowInput[]>(() => initRows(variants));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function updateLabel(index: number, value: string) {
    setLabels((prev) => prev.map((label, i) => (i === index ? value : label)));
  }

  function updateRow(index: number, patch: Partial<VariantRowInput>) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function updateRowValue(index: number, valueIndex: number, value: string) {
    setRows((prev) =>
      prev.map((row, i) =>
        i === index ? { ...row, values: row.values.map((v, vi) => (vi === valueIndex ? value : v)) } : row,
      ),
    );
  }

  function addRow() {
    setRows((prev) => [...prev, emptyRow()]);
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSave() {
    setError(null);
    const payload = buildVariantsPayload(labels, rows);

    if (payload.options.length === 0) {
      setError('Agrega al menos una etiqueta de opción antes de guardar variantes.');
      return;
    }

    const parsed = variantsReplaceSchema.safeParse(payload);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Revisa los datos de las variantes.');
      return;
    }

    setSubmitting(true);
    try {
      const updated = await apiFetch<Product>(`/v1/admin/products/${productId}/variants`, {
        method: 'PUT',
        body: JSON.stringify(parsed.data),
      });
      onUpdate(updated);
      setLabels(initLabels(updated.options));
      setRows(initRows(updated.variants));
    } catch (e) {
      setError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {labels.map((label, index) => (
          <Input
            key={index}
            placeholder={`Etiqueta ${index + 1} (ej: Talla)`}
            value={label}
            onChange={(event) => updateLabel(index, event.target.value)}
            aria-label={`Etiqueta de opción ${index + 1}`}
          />
        ))}
      </div>

      <Table>
        <Thead>
          <Tr>
            {labels.map((label, index) => (
              <Th key={index}>{label.trim() || `Opción ${index + 1}`}</Th>
            ))}
            <Th>Precio (COP)</Th>
            <Th>SKU</Th>
            <Th>Stock</Th>
            <Th>
              <span className="sr-only">Acciones</span>
            </Th>
          </Tr>
        </Thead>
        <Tbody>
          {rows.map((row, rowIndex) => (
            <Tr key={rowIndex}>
              {row.values.map((value, valueIndex) => (
                <Td key={valueIndex}>
                  <Input
                    value={value}
                    onChange={(event) => updateRowValue(rowIndex, valueIndex, event.target.value)}
                    aria-label={`${labels[valueIndex]?.trim() || `Opción ${valueIndex + 1}`} (fila ${rowIndex + 1})`}
                  />
                </Td>
              ))}
              <Td>
                <Input
                  type="number"
                  min={0}
                  step="1"
                  placeholder="Igual al precio base"
                  value={row.priceCentsPesos}
                  onChange={(event) => updateRow(rowIndex, { priceCentsPesos: event.target.value })}
                  aria-label={`Precio (fila ${rowIndex + 1})`}
                />
              </Td>
              <Td>
                <Input
                  value={row.sku}
                  onChange={(event) => updateRow(rowIndex, { sku: event.target.value })}
                  aria-label={`SKU (fila ${rowIndex + 1})`}
                />
              </Td>
              <Td>
                <Input
                  type="number"
                  min={0}
                  step="1"
                  value={row.stock}
                  onChange={(event) => updateRow(rowIndex, { stock: event.target.value })}
                  aria-label={`Stock (fila ${rowIndex + 1})`}
                />
              </Td>
              <Td>
                <Button variant="destructive" size="sm" onClick={() => removeRow(rowIndex)}>
                  Quitar
                </Button>
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>

      <Button variant="secondary" size="sm" className="self-start" onClick={addRow}>
        Agregar variante
      </Button>

      {error ? <Alert variant="error">{error}</Alert> : null}
      <Alert variant="info">Guardar variantes reemplaza el conjunto actual.</Alert>

      <Button disabled={submitting} className="self-start" onClick={() => void handleSave()}>
        {submitting ? 'Guardando…' : 'Guardar variantes'}
      </Button>
    </div>
  );
}
