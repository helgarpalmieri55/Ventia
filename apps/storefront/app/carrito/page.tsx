'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button, Table, Thead, Tbody, Tr, Th, Td } from '@ventia/ui';
import { formatCOP } from '../../lib/format';
import { useCart } from '../../lib/cart-context';
import { adoptCart } from '../../lib/agent-api';

const MUTATION_ERROR = 'No pudimos actualizar tu carrito. Intenta de nuevo.';
const STALE_LINK = 'Este enlace ya no está disponible. Te mostramos tu carrito actual.';

/** The fuller `/carrito` cart page — same data/state as `CartDrawer` (via the
 * same `useCart()` context), just more room: a table instead of a compact
 * list. Needs `'use client'` (not just a client sub-component) since the
 * whole page's content is the live cart from context, not a server fetch —
 * there's no useful server-rendered shell around it.
 *
 * The Suspense boundary is here because `CarritoContent` reads
 * `useSearchParams` (for the agent's `?c=` cart link) and Next refuses to
 * prerender a client component that calls it unboundaried. A boundary rather
 * than `force-dynamic` on the whole route: the shell around it can still be
 * static. The fallback matches the loading state inside, so a shopper
 * following an agent's link never sees the page flash "vacío" on its way to
 * their basket. */
export default function CarritoPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-4xl px-4 py-8">
          <p className="text-sm text-muted-foreground">Cargando carrito…</p>
        </main>
      }
    >
      <CarritoContent />
    </Suspense>
  );
}

function CarritoContent() {
  const { cart, loading, updateItem, removeItem, refreshCart } = useCart();
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [staleLink, setStaleLink] = useState(false);
  const cartLinkKey = useSearchParams().get('c');
  // `null` until the adoption attempt settles, so the page shows the loading
  // state instead of flashing "tu carrito está vacío" at a shopper who just
  // followed a link to a full one.
  const [adopting, setAdopting] = useState<boolean>(cartLinkKey !== null);

  // Adopts the cart behind an agent's `/carrito?c=<key>` link. Without this
  // the tool's whole output is dead — the link opens the shopper's own
  // (usually empty) cart and everything the agent assembled is lost.
  //
  // Runs client-side rather than in a Server Component because the point is
  // the Set-Cookie the API returns, which has to land on the browser that
  // will make every later cart call.
  useEffect(() => {
    if (!cartLinkKey) return;
    let cancelled = false;
    adoptCart(cartLinkKey)
      .then((ok) => {
        if (cancelled) return;
        // A stale or already-consumed link is not an error worth alarming
        // anyone about: say so quietly and show whatever cart they do have.
        if (!ok) setStaleLink(true);
        else return refreshCart();
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('[cart] failed to adopt cart link', err);
          setStaleLink(true);
        }
      })
      .finally(() => {
        if (!cancelled) setAdopting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cartLinkKey, refreshCart]);

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

  if (adopting || (loading && !cart)) {
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
        {staleLink ? <p className="mb-2 text-sm text-muted-foreground">{STALE_LINK}</p> : null}
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
      {staleLink ? <p className="mb-4 text-sm text-muted-foreground">{STALE_LINK}</p> : null}
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
