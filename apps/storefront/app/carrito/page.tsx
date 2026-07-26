'use client';

import { Button, Table, Thead, Tbody, Tr, Th, Td } from '@ventia/ui';
import { formatCOP } from '../../lib/format';
import { useCart } from '../../lib/cart-context';

/** The fuller `/carrito` cart page — same data/state as `CartDrawer` (via the
 * same `useCart()` context), just more room: a table instead of a compact
 * list. Needs `'use client'` (not just a client sub-component) since the
 * whole page's content is the live cart from context, not a server fetch —
 * there's no useful server-rendered shell around it. */
export default function CarritoPage() {
  const { cart, loading, updateItem, removeItem } = useCart();

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
                  value={line.qty}
                  onChange={(e) => {
                    const qty = Number(e.target.value);
                    if (Number.isInteger(qty) && qty > 0) void updateItem(line.id, qty);
                  }}
                  className="h-9 w-20 rounded-md border border-border bg-background px-2 text-sm"
                />
              </Td>
              <Td>{formatCOP(line.priceCents)}</Td>
              <Td>{formatCOP(line.lineSubtotalCents)}</Td>
              <Td>
                <button
                  type="button"
                  onClick={() => void removeItem(line.id)}
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

      {/* Task 8 builds the full checkout flow — no `/checkout` route exists
          yet, so this stays a plain disabled-looking affordance rather than
          linking somewhere that 404s. */}
      <div className="mt-6 flex justify-end">
        <Button disabled title="Disponible próximamente">
          Ir a pagar
        </Button>
      </div>
    </main>
  );
}
