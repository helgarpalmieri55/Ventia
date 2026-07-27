'use client';

import { useState } from 'react';
import { Button, Table, Thead, Tbody, Tr, Th, Td } from '@ventia/ui';
import { formatCOP } from '../../lib/format';
import { useCart } from '../../lib/cart-context';

const MUTATION_ERROR = 'No pudimos actualizar tu carrito. Intenta de nuevo.';

/** The fuller `/carrito` cart page — same data/state as `CartDrawer` (via the
 * same `useCart()` context), just more room: a table instead of a compact
 * list. Needs `'use client'` (not just a client sub-component) since the
 * whole page's content is the live cart from context, not a server fetch —
 * there's no useful server-rendered shell around it. */
export default function CarritoPage() {
  const { cart, loading, updateItem, removeItem } = useCart();
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

  if (loading && !cart) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <p className="text-sm text-muted-foreground">Cargando carrito…</p>
      </main>
    );
  }

  if (!cart || cart.lines.length === 0) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <h1 className="mb-4 text-2xl font-semibold">Tu carrito</h1>
        <p className="text-sm text-muted-foreground">Tu carrito está vacío.</p>
        <Button href="/" className="mt-4">
          Seguir comprando
        </Button>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-semibold">Tu carrito</h1>
      {mutationError ? <p className="mb-4 text-sm text-destructive">{mutationError}</p> : null}
      <Table>
        <Thead>
          <Tr>
            <Th>Producto</Th>
            <Th>Cantidad</Th>
            <Th>Precio</Th>
            <Th>Subtotal</Th>
            <Th />
          </Tr>
        </Thead>
        <Tbody>
          {cart.lines.map((line) => (
            <Tr key={line.id}>
              <Td>{line.name}</Td>
              <Td>
                <input
                  type="number"
                  min={1}
                  aria-label={`Cantidad de ${line.name}`}
                  value={line.qty}
                  onChange={(e) => {
                    const qty = Number(e.target.value);
                    if (Number.isInteger(qty) && qty > 0) handleUpdateItem(line.id, qty);
                  }}
                  className="h-9 w-20 rounded-md border border-border bg-background px-2 text-sm"
                />
              </Td>
              <Td>{formatCOP(line.priceCents)}</Td>
              <Td>{formatCOP(line.lineSubtotalCents)}</Td>
              <Td>
                <button
                  type="button"
                  onClick={() => handleRemoveItem(line.id)}
                  className="text-sm text-muted-foreground underline"
                >
                  Quitar
                </button>
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>

      <div className="mt-6 flex flex-col items-end gap-1 text-sm">
        <div className="flex w-48 justify-between">
          <span className="text-muted-foreground">Subtotal</span>
          <span>{formatCOP(cart.subtotalCents)}</span>
        </div>
        <div className="flex w-48 justify-between">
          <span className="text-muted-foreground">Impuestos</span>
          <span>{formatCOP(cart.taxCents)}</span>
        </div>
        <div className="flex w-48 justify-between text-base font-semibold">
          <span>Total</span>
          <span>{formatCOP(cart.subtotalCents + cart.taxCents)}</span>
        </div>
      </div>

      <div className="mt-6 flex justify-end">
        <Button href="/checkout">Ir a pagar</Button>
      </div>
    </main>
  );
}
