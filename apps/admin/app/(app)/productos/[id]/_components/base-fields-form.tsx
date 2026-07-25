'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { TAX_RATES, productUpdateSchema } from '@ventia/core';
import { Alert, Button, FormField, Input, Select, cn } from '@ventia/ui';
import { ApiError, apiFetch } from '../../../../../lib/api';
import { errorMessage, fieldErrors } from '../../../../../lib/errors';
import { centsToPesos, pesosToCents } from '../../../../../lib/format';
import { STATUS_LABELS, TAX_RATE_LABELS, type ProductStatus } from '../../../../../lib/product-labels';
import { zodIssuesToFieldErrors } from '../../../../../lib/validation';
import { CategoryChecklist } from '../../_components/category-checklist';
import { useCategories } from '../../_components/use-categories';
import { seoFields, type Product } from './product-types';

const STATUS_OPTIONS: ProductStatus[] = ['draft', 'active', 'archived'];

const TEXTAREA_CLASS = cn(
  'flex w-full min-h-[120px] resize-y rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50',
);

export interface BaseFieldsFormProps {
  product: Product;
  onUpdate: (updated: Product) => void;
}

/** Section 1 of the edit page: the same fields as the create form, PATCHed
 * via `productUpdateSchema` — deliberately WITHOUT a `stock` field (the API
 * omits `stock` from that schema entirely; all post-create stock changes
 * must go through the dedicated stock adjuster below, which is audited).
 * `status` is a plain select here, including 'archived' — moving an
 * archived product to any other status through this form is exactly the
 * "un-archive" path, which the server may reject with `PLAN_LIMIT_EXCEEDED`
 * (402) if the tenant's plan is already at its non-archived product cap;
 * that's just another `ApiError` handled by the same catch block below via
 * `errorMessage`, no special-casing needed on this side. */
export function BaseFieldsForm({ product, onUpdate }: BaseFieldsFormProps) {
  const { categories, loading: categoriesLoading, loadError: categoriesError } = useCategories();
  const initialSeo = seoFields(product.seo);

  const [name, setName] = useState(product.name);
  const [descriptionMd, setDescriptionMd] = useState(product.descriptionMd);
  const [priceCentsPesos, setPriceCentsPesos] = useState(String(centsToPesos(product.priceCents)));
  const [compareAtCentsPesos, setCompareAtCentsPesos] = useState(
    product.compareAtCents != null ? String(centsToPesos(product.compareAtCents)) : '',
  );
  const [sku, setSku] = useState(product.sku ?? '');
  const [barcode, setBarcode] = useState(product.barcode ?? '');
  const [trackInventory, setTrackInventory] = useState(product.trackInventory);
  const [taxRate, setTaxRate] = useState<(typeof TAX_RATES)[number]>(product.taxRate);
  const [status, setStatus] = useState<ProductStatus>(product.status);
  const [categoryIds, setCategoryIds] = useState<Set<string>>(new Set(product.categoryIds ?? []));
  const [seoTitle, setSeoTitle] = useState(initialSeo.title);
  const [seoDescription, setSeoDescription] = useState(initialSeo.description);

  const [formError, setFormError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // Keeps the status select in sync with an archive/unarchive that happened
  // through a different control (the "Archivar producto" button below) —
  // without this, archiving there would leave this select silently showing
  // the old status until a full page reload, and a subsequent "Guardar
  // cambios" here would then PATCH the product right back to that stale
  // status.
  useEffect(() => {
    setStatus(product.status);
  }, [product.status]);

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
      trackInventory,
      taxRate,
      status,
      categoryIds: Array.from(categoryIds),
      seo: Object.keys(seo).length ? seo : undefined,
    };

    const parsed = productUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      setErrors(zodIssuesToFieldErrors(parsed.error));
      return;
    }

    setSubmitting(true);
    try {
      const updated = await apiFetch<Product>(`/v1/admin/products/${product.id}`, {
        method: 'PATCH',
        body: JSON.stringify(parsed.data),
      });
      onUpdate(updated);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'VALIDATION_FAILED') setErrors(fieldErrors(e));
        else setFormError(errorMessage(e));
      } else {
        setFormError('Ocurrió un error inesperado. Intenta de nuevo.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="flex flex-col gap-6" onSubmit={handleSubmit} noValidate>
      {formError ? <Alert variant="error">{formError}</Alert> : null}

      <div className="flex flex-col gap-4">
        <FormField label="Nombre" htmlFor="name" error={errors.name}>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
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
            value={priceCentsPesos}
            onChange={(event) => setPriceCentsPesos(event.target.value)}
          />
        </FormField>
        <FormField
          label="Precio antes de descuento (COP, opcional)"
          htmlFor="compareAtCents"
          error={errors.compareAtCents}
        >
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

      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={trackInventory}
          onChange={(event) => setTrackInventory(event.target.checked)}
          className="h-4 w-4 rounded border-border"
        />
        Rastrear inventario
      </label>

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

      <Button type="submit" disabled={submitting} className="self-start">
        {submitting ? 'Guardando…' : 'Guardar cambios'}
      </Button>
    </form>
  );
}
