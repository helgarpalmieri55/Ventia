import type { TaxRateValue } from '@ventia/core';
import type { ProductStatus } from '../../../../../lib/product-labels';

export interface ProductImage {
  id: string;
  url: string;
  alt: string | null;
  position: number;
}

export interface ProductVariant {
  id: string;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  priceCents: number | null;
  sku: string | null;
  stock: number;
}

/** Mirrors `ProductDTO` from `services/api/src/catalog/products.service.ts`
 * (only the fields the admin UI actually reads — `tenantId`/`costCents`/
 * `createdAt`/`updatedAt` are present on the wire but unused here). */
export interface Product {
  id: string;
  name: string;
  slug: string;
  descriptionMd: string;
  priceCents: number;
  compareAtCents: number | null;
  sku: string | null;
  barcode: string | null;
  stock: number;
  trackInventory: boolean;
  taxRate: TaxRateValue;
  status: ProductStatus;
  seo: unknown;
  options: string[];
  images: ProductImage[];
  variants: ProductVariant[];
  categoryIds?: string[];
}

/** `Product.seo` comes over the wire as `Prisma.JsonValue` (so, at runtime,
 * whatever was stored — expected to be `{ title?, description? }` or
 * null/undefined, but not guaranteed by the type system on this side).
 * Defensively narrows to plain strings for populating the SEO form
 * fields. */
export function seoFields(seo: unknown): { title: string; description: string } {
  if (seo && typeof seo === 'object') {
    const record = seo as Record<string, unknown>;
    return {
      title: typeof record.title === 'string' ? record.title : '',
      description: typeof record.description === 'string' ? record.description : '',
    };
  }
  return { title: '', description: '' };
}
