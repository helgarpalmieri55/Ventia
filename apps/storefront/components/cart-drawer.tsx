'use client';

import { useState } from 'react';
import { Button, Dialog } from '@ventia/ui';
import { formatCOP } from '../lib/format';
import { useCart } from '../lib/cart-context';

const MUTATION_ERROR = 'No pudimos actualizar tu carrito. Intenta de nuevo.';

/** The storefront's first client component (P2b): the `Dialog`-based cart
 * drawer, mounted once in the root layout alongside `<CartProvider>` so it is
 * available on every page.
 *
 * It used to render its own trigger too — a fixed-position circle at
 * `right-4 top-4`, because at the time there was no header in this app to
 * slot a trigger into. There is one now (components/site-header.tsx), and two
 * elements claiming the top-right corner is one too many, so the trigger
 * moved into it as `CartButton`. Opening still goes through `useCart`'s
 * `openCart`, which is why the two halves can live in different components
 * without talking to each other. */
export function CartDrawer() {
  const { cart, loading, isOpen, closeCart, updateItem, removeItem } = useCart();
  const [mutationError, setMutationError] = useState<string | null>(null);

  function handleUpdateItem(itemId: string, qty: number) {
    setMutationError(null);
    updateItem(itemId, qty).catch((err) => {
      console.error('[cart] failed to update item', err);
      setMutationError(MUTATION_ERROR);
    });
  }

  function handleRemoveItem(itemId: string) {
    setMutationError(null);
    removeItem(itemId).catch((err) => {
      console.error('[cart] failed to remove item', err);
      setMutationError(MUTATION_ERROR);
    });
  }

  return (
    <Dialog open={isOpen} onClose={closeCart} className="max-w-sm">
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Tu carrito</h2>
          <button type="button" onClick={closeCart} aria-label="Cerrar" className="text-muted-foreground">
            ✕
          </button>
        </div>

        {mutationError ? <p className="text-sm text-destructive">{mutationError}</p> : null}

        {loading && !cart ? (
          <p className="text-sm text-muted-foreground">Cargando tu carrito…</p>
        ) : !cart || cart.lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">Tu carrito está vacío.</p>
        ) : (
          <>
            <ul className="flex flex-col gap-3">
              {cart.lines.map((line) => (
                <li key={line.id} className="flex flex-col gap-1 border-b border-border pb-3 last:border-none">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{line.name}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveItem(line.id)}
                      aria-label={`Quitar ${line.name}`}
                      className="text-xs text-muted-foreground underline"
                    >
                      Quitar
                    </button>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <label className="flex items-center gap-2">
                      <span className="text-muted-foreground">Cant.</span>
                      <input
                        type="number"
                        min={1}
                        aria-label={`Cantidad de ${line.name}`}
                        value={line.qty}
                        onChange={(e) => {
                          const qty = Number(e.target.value);
                          if (Number.isInteger(qty) && qty > 0) handleUpdateItem(line.id, qty);
                        }}
                        className="h-8 w-16 rounded-md border border-border bg-background px-2 text-sm"
                      />
                    </label>
                    <span>{formatCOP(line.lineSubtotalCents)}</span>
                  </div>
                </li>
              ))}
            </ul>

            <div className="flex flex-col gap-1 border-t border-border pt-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span>{formatCOP(cart.subtotalCents)}</span>
              </div>
              {/* "IVA incluido", not an addition — see the cart page's
                  identical block and SPEC.md §5. */}
              <div className="flex justify-between">
                <span className="text-muted-foreground">IVA incluido</span>
                <span>{formatCOP(cart.taxCents)}</span>
              </div>
            </div>
          </>
        )}

        {/* `href`, not a wrapping <Link>: Button's `href` prop renders a
            single styled <a>, avoiding an invalid nested
            interactive-element DOM (see button.tsx's doc comment). */}
        <Button href="/carrito" onClick={closeCart} className="w-full">
          Ver carrito
        </Button>
      </div>
    </Dialog>
  );
}
