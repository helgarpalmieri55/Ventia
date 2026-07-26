'use client';

import * as React from 'react';
import { Button, Select } from '@ventia/ui';
import { useCart } from '../lib/cart-context';

export interface AddToCartVariant {
  id: string;
  option1: string | null;
  option2: string | null;
  option3: string | null;
}

const VARIANT_OPTION_KEYS = ['option1', 'option2', 'option3'] as const;

/** Distinct, non-null values a given option position (0-based, matching
 * `options[position]`'s label) takes across `variants`, in first-seen order.
 * Copy of `app/productos/[slug]/page.tsx`'s former helper of the same name —
 * moved here because the select it feeds is now owned by this client
 * component (it used to be purely decorative server-rendered markup with no
 * state; now the selection actually drives which variant gets added). */
function distinctVariantOptionValues(variants: AddToCartVariant[], position: number): string[] {
  const key = VARIANT_OPTION_KEYS[position];
  const values: string[] = [];
  for (const variant of variants) {
    const value = variant[key];
    if (value && !values.includes(value)) values.push(value);
  }
  return values;
}

export interface AddToCartProps {
  productId: string;
  options: string[];
  variants: AddToCartVariant[];
  inStock: boolean;
}

/** The PDP's variant-selection + "Agregar al carrito" island — the one place
 * P2a deliberately left inert ("a later task (P2b) wires real variant-aware
 * add-to-cart"). The rest of the PDP (images, price, description, related
 * products) stays a Server Component; only this piece needs interactivity,
 * so it's split into its own small client component rather than making the
 * whole page client-rendered. */
export function AddToCart({ productId, options, variants, inStock }: AddToCartProps) {
  const { addItem, openCart } = useCart();
  const [selected, setSelected] = React.useState<string[]>(() => options.map(() => ''));
  const [submitting, setSubmitting] = React.useState(false);

  const hasVariants = options.length > 0;
  const allSelected = !hasVariants || selected.every((v) => v !== '');

  // Resolves the single variant whose option1/2/3 match every selected
  // value — `null` for a no-variant product (options.length === 0), the
  // shape `CartService.addItem` expects either way.
  const selectedVariantId = React.useMemo<string | null>(() => {
    if (!hasVariants) return null;
    if (!allSelected) return null;
    const match = variants.find((variant) =>
      options.every((_, i) => variant[VARIANT_OPTION_KEYS[i]] === selected[i]),
    );
    return match?.id ?? null;
  }, [hasVariants, allSelected, variants, options, selected]);

  const canAdd = inStock && allSelected && (!hasVariants || selectedVariantId !== null);

  async function handleAdd() {
    if (!canAdd || submitting) return;
    setSubmitting(true);
    try {
      await addItem(productId, selectedVariantId, 1);
      openCart();
    } catch (err) {
      console.error('[cart] failed to add item', err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {hasVariants ? (
        <div className="flex flex-col gap-3">
          {options.map((optionName, i) => (
            <label key={optionName} className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{optionName}</span>
              <Select
                value={selected[i]}
                onChange={(e) => {
                  const value = e.target.value;
                  setSelected((prev) => prev.map((v, idx) => (idx === i ? value : v)));
                }}
              >
                <option value="" disabled>
                  Selecciona {optionName.toLowerCase()}
                </option>
                {distinctVariantOptionValues(variants, i).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </label>
          ))}
        </div>
      ) : null}

      <div>
        <Button
          onClick={() => void handleAdd()}
          disabled={!canAdd || submitting}
          title={!inStock ? 'Agotado' : undefined}
        >
          Agregar al carrito
        </Button>
      </div>
    </div>
  );
}
