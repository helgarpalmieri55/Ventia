'use client';

import { Button, Dialog } from '@ventia/ui';
import { formatCOP } from '../lib/format';
import { useCart } from '../lib/cart-context';

/** The storefront's first client component (P2b). Renders both halves of the
 * cart UI from one mount point: a small always-visible fixed-position
 * trigger button (there's no existing header/nav in this app to slot a
 * trigger into — see app/layout.tsx) and the `Dialog`-based drawer it opens.
 * Mounting `<CartDrawer />` once in the root layout, alongside
 * `<CartProvider>`, is sufficient to get both on every page. */
export function CartDrawer() {
  const { cart, isOpen, openCart, closeCart, updateItem, removeItem } = useCart();

  const itemCount = cart?.lines.reduce((sum, line) => sum + line.qty, 0) ?? 0;

  return (
    <>
      <button
        type="button"
        onClick={openCart}
        aria-label="Ver carrito"
        className="fixed right-4 top-4 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-border bg-background shadow-md"
      >
        <span aria-hidden="true">🛒</span>
        {itemCount > 0 ? (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-xs font-medium text-primary-foreground">
            {itemCount}
          </span>
        ) : null}
      </button>

      <Dialog open={isOpen} onClose={closeCart} className="max-w-sm">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Tu carrito</h2>
            <button type="button" onClick={closeCart} aria-label="Cerrar" className="text-muted-foreground">
              ✕
            </button>
          </div>

          {!cart || cart.lines.length === 0 ? (
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
                        onClick={() => void removeItem(line.id)}
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
                          value={line.qty}
                          onChange={(e) => {
                            const qty = Number(e.target.value);
                            if (Number.isInteger(qty) && qty > 0) void updateItem(line.id, qty);
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
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Impuestos</span>
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
    </>
  );
}
