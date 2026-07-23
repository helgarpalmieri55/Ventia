import { z } from 'zod';

export const TAX_RATES = ['0', '5', '19', 'excluido'] as const;
export type TaxRateValue = (typeof TAX_RATES)[number];

const money = z.number().int().min(0);

export const categoryInputSchema = z.object({
  name: z.string().min(1).max(80),
  slug: z.string().min(1).max(60).optional(),
  position: z.number().int().min(0).optional(),
});

export const productInputSchema = z.object({
  name: z.string().min(1).max(160),
  slug: z.string().min(1).max(60).optional(),
  descriptionMd: z.string().max(20_000).default(''),
  priceCents: money,
  compareAtCents: money.optional(),
  costCents: money.optional(),
  sku: z.string().max(64).optional(),
  barcode: z.string().max(64).optional(),
  stock: z.number().int().min(0).default(0),
  trackInventory: z.boolean().default(true),
  taxRate: z.enum(TAX_RATES).default('19'),
  status: z.enum(['draft', 'active', 'archived']).default('draft'),
  categoryIds: z.array(z.string().uuid()).max(20).default([]),
  seo: z.object({ title: z.string().max(70), description: z.string().max(160) }).partial().optional(),
});
export const productUpdateSchema = productInputSchema.partial();

export const variantsReplaceSchema = z.object({
  options: z.array(z.string().min(1).max(30)).min(1).max(3),
  variants: z
    .array(
      z.object({
        option1: z.string().max(60).optional(),
        option2: z.string().max(60).optional(),
        option3: z.string().max(60).optional(),
        priceCents: money.optional(),
        sku: z.string().max(64).optional(),
        stock: z.number().int().min(0).default(0),
      }),
    )
    .max(100),
});

export const presignRequestSchema = z.object({
  filename: z.string().min(1).max(200),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  size: z.number().int().min(1).max(5 * 1024 * 1024),
});

export const imageConfirmSchema = z.object({
  key: z.string().min(1).max(300),
  alt: z.string().max(160).optional(),
  position: z.number().int().min(0).default(0),
});

export const stockAdjustSchema = z.object({
  variantId: z.string().uuid().optional(),
  delta: z.number().int().refine((n) => n !== 0, 'delta must be non-zero'),
  reason: z.enum(['restock', 'manual_adjust', 'correction']),
});

export type ProductInput = z.infer<typeof productInputSchema>;
export type ProductUpdate = z.infer<typeof productUpdateSchema>;
export type CategoryInput = z.infer<typeof categoryInputSchema>;
export type VariantsReplace = z.infer<typeof variantsReplaceSchema>;
export type StockAdjust = z.infer<typeof stockAdjustSchema>;
