'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { TAX_RATES, productInputSchema } from '@ventia/core';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, FormField, Input, Select, cn } from '@ventia/ui';
import { ApiError, apiFetch } from '../../../../lib/api';
import { errorMessage, fieldErrors } from '../../../../lib/errors';
import { pesosToCents } from '../../../../lib/format';
import { STATUS_LABELS, TAX_RATE_LABELS, type ProductStatus } from '../../../../lib/product-labels';
import { zodIssuesToFieldErrors } from '../../../../lib/validation';
import { CategoryChecklist } from '../_components/category-checklist';
import { useCategories } from '../_components/use-categories';

const STATUS_OPTIONS: ProductStatus[] = ['draft', 'active', 'archived'];

const TEXTAREA_CLASS = cn(
  'flex w-full min-h-[120px] resize-y rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50',
);

/** Create-product form. Client-side validated against `productInputSchema`
 * before submit (zod issues mapped to field errors via
 * `zodIssuesToFieldErrors`) so obviously-bad input never round-trips to the
 * server; a server-side VALIDATION_FAILED (a real race, or a rule the
 * client can't check, e.g. `categoryIds` referencing a category deleted in
 * another tab) is mapped the same way via `fieldErrors`. `SLUG_TAKEN`,
 * `SKU_TAKEN` and `PLAN_LIMIT_EXCEEDED` are the interesting non-field
 * errors and render as a top-of-form `Alert` via `errorMessage`. On success,
 * redirects to `/productos/[id]` (the edit page) rather than back to the
 * list, matching the binding contract. */
export default function NuevoProductoPage() {
  const router = useRouter();
  const { categories, loading: categoriesLoading, loadError: categoriesError } = useCategories();

  const [name, setName] = useState('');
  const [descriptionMd, setDescriptionMd] = useState('');
  const [priceCentsPesos, setPriceCentsPesos] = useState('');
  const [compareAtCentsPesos, setCompareAtCentsPesos] = useState('');
  const [sku, setSku] = useState('');
  const [barcode, setBarcode] = useState('');
  const [stock, setStock] = useState('0');
  const [trackInventory, setTrackInventory] = useState(true);
  const [taxRate, setTaxRate] = useState<(typeof TAX_RATES)[number]>('19');
  const [status, setStatus] = useState<ProductStatus>('draft');
  const [categoryIds, setCategoryIds] = useState<Set<string>>(new Set());
  const [seoTitle, setSeoTitle] = useState('');
  const [seoDescription, setSeoDescription] = useState('');

  const [formError, setFormError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  function toggleCategory(id: string) {
    setCategoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setErrors({});

    const compareAtTrim = compareAtCentsPesos.trim();
    const seoTitleTrim = seoTitle.trim();
    const seoDescTrim = seoDescription.trim();
    const seo: { title?: string; description?: string } = {};
    if (seoTitleTrim) seo.title = seoTitleTrim;
    if (seoDescTrim) seo.description = seoDescTrim;

    const raw = {
      name: name.trim(),
      descriptionMd,
      priceCents: pesosToCents(priceCentsPesos) ?? Number.NaN,
      compareAtCents: compareAtTrim === '' ? undefined : pesosToCents(compareAtTrim) ?? Number.NaN,
      sku: sku.trim() || undefined,
      barcode: barcode.trim() || undefined,
      stock: stock.trim() === '' ? undefined : Number(stock.trim()),
      trackInventory,
      taxRate,
      status,
      categoryIds: Array.from(categoryIds),
      seo: Object.keys(seo).length ? seo : undefined,
    };

    const parsed = productInputSchema.safeParse(raw);
    if (!parsed.success) {
      setErrors(zodIssuesToFieldErrors(parsed.error));
      return;
    }

    setSubmitting(true);
    try {
      const product = await apiFetch<{ id: string }>('/v1/admin/products', {
        method: 'POST',
        body: JSON.stringify(parsed.data),
      });
      router.push(`/productos/${product.id}`);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'VALIDATION_FAILED') setErrors(fieldErrors(e));
        else setFormError(errorMessage(e));
      } else {
        setFormError('Ocurrió un error inesperado. Intenta de nuevo.');
      }
      setSubmitting(false);
    }
  }

  return (
    <Card className="w-full max-w-3xl">
      <CardHeader>
        <CardTitle>Nuevo producto</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-6" onSubmit={handleSubmit} noValidate>
          {formError ? <Alert variant="error">{formError}</Alert> : null}

          <div className="flex flex-col gap-4">
            <FormField label="Nombre" htmlFor="name" error={errors.name}>
              <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
            </FormField>
            <FormField label="Descripción" htmlFor="descriptionMd" error={errors.descriptionMd}>
              <textarea
                className={TEXTAREA_CLASS}
                value={descriptionMd}
                onChange={(event) => setDescriptionMd(event.target.value)}
              />
            </FormField>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Precio (COP)" htmlFor="priceCents" error={errors.priceCents}>
              <Input
                type="number"
                min={0}
                step="1"
                inputMode="decimal"
                placeholder="45900"
                value={priceCentsPesos}
                onChange={(event) => setPriceCentsPesos(event.target.value)}
              />
            </FormField>
            <FormField label="Precio antes de descuento (COP, opcional)" htmlFor="compareAtCents" error={errors.compareAtCents}>
              <Input
                type="number"
                min={0}
                step="1"
                inputMode="decimal"
                value={compareAtCentsPesos}
                onChange={(event) => setCompareAtCentsPesos(event.target.value)}
              />
            </FormField>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="SKU (opcional)" htmlFor="sku" error={errors.sku}>
              <Input value={sku} onChange={(event) => setSku(event.target.value)} />
            </FormField>
            <FormField label="Código de barras (opcional)" htmlFor="barcode" error={errors.barcode}>
              <Input value={barcode} onChange={(event) => setBarcode(event.target.value)} />
            </FormField>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Stock inicial" htmlFor="stock" error={errors.stock}>
              <Input
                type="number"
                min={0}
                step="1"
                value={stock}
                onChange={(event) => setStock(event.target.value)}
              />
            </FormField>
            <label className="flex items-end gap-2 pb-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={trackInventory}
                onChange={(event) => setTrackInventory(event.target.checked)}
                className="h-4 w-4 rounded border-border"
              />
              Rastrear inventario
            </label>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="IVA" htmlFor="taxRate" error={errors.taxRate}>
              <Select value={taxRate} onChange={(event) => setTaxRate(event.target.value as (typeof TAX_RATES)[number])}>
                {TAX_RATES.map((rate) => (
                  <option key={rate} value={rate}>
                    {TAX_RATE_LABELS[rate]}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Estado" htmlFor="status" error={errors.status}>
              <Select value={status} onChange={(event) => setStatus(event.target.value as ProductStatus)}>
                {STATUS_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {STATUS_LABELS[value]}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-foreground">Categorías</span>
            {errors.categoryIds ? <Alert variant="error">{errors.categoryIds}</Alert> : null}
            <CategoryChecklist
              categories={categories}
              loading={categoriesLoading}
              loadError={categoriesError}
              selected={categoryIds}
              onToggle={toggleCategory}
            />
          </div>

          <div className="flex flex-col gap-4">
            <span className="text-sm font-medium text-foreground">SEO (opcional)</span>
            {errors.seo ? <Alert variant="error">{errors.seo}</Alert> : null}
            <FormField label="Título SEO" htmlFor="seoTitle">
              <Input value={seoTitle} onChange={(event) => setSeoTitle(event.target.value)} />
            </FormField>
            <FormField label="Descripción SEO" htmlFor="seoDescription">
              <Input value={seoDescription} onChange={(event) => setSeoDescription(event.target.value)} />
            </FormField>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" href="/productos">
              Cancelar
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Creando…' : 'Crear producto'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
