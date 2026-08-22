'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert, Badge, Button, Card, CardContent, Spinner } from '@ventia/ui';
import { ProductImage } from './product-image';
import { formatCOP } from '../lib/format';
import { useShopper } from '../lib/shopper-context';
import { fetchWishlist, removeFromWishlist, wishlistErrorMessage, type WishlistItem } from '../lib/wishlist-api';

const LOAD_ERROR = 'No pudimos cargar tus favoritos. Intenta de nuevo.';

/**
 * `/cuenta/favoritos` — the products the shopper saved.
 *
 * ## Removal is optimistic, and that is safe here specifically
 *
 * The row disappears before the request comes back, and is put back if it
 * fails. That is a reasonable trade for this operation and would not be for a
 * cart or an address: `DELETE /wishlist/:productId` is idempotent and answers
 * 204 whether or not the item was there, so the only way to be wrong is a
 * transport failure — and the recovery (put the row back, say so) restores
 * exactly the state the shopper was looking at. Waiting instead would make
 * every removal feel broken on a slow connection, on a screen whose entire
 * purpose is tidying a list.
 *
 * ## An unavailable product keeps its row but loses its link
 *
 * The API deliberately keeps archived products in the list rather than
 * dropping them, because a list that silently shrinks reads as data loss. The
 * obligation that creates here is not to link those rows to a PDP that would
 * 404 — the shopper is told the product is unavailable instead, which is the
 * true and useful answer.
 */
export function WishlistArea() {
  const router = useRouter();
  const { shopper, loading: sessionLoading } = useShopper();

  const [items, setItems] = React.useState<WishlistItem[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!sessionLoading && !shopper) router.replace('/cuenta/entrar');
  }, [sessionLoading, shopper, router]);

  React.useEffect(() => {
    if (sessionLoading || !shopper) return;
    let cancelled = false;
    setLoading(true);
    fetchWishlist()
      .then((rows) => {
        if (!cancelled) setItems(rows);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[wishlist] failed to load', err);
        setError(LOAD_ERROR);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionLoading, shopper]);

  async function handleRemove(productId: string) {
    setError(null);
    setBusyId(productId);
    // Captured BEFORE the optimistic update so the rollback restores the list
    // as it actually was, including the removed row's position.
    const previous = items;
    setItems((rows) => rows?.filter((row) => row.productId !== productId) ?? rows);
    try {
      await removeFromWishlist(productId);
    } catch (err) {
      console.error('[wishlist] failed to remove', err);
      setItems(previous);
      setError(wishlistErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  if (sessionLoading || !shopper) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-8">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Cargando…
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Mis favoritos</h1>
        <Link href="/cuenta" className="text-sm underline underline-offset-4">
          Volver a mi cuenta
        </Link>
      </div>

      {error ? <Alert variant="error">{error}</Alert> : null}

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Cargando tus favoritos…
        </p>
      ) : !items || items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-3 py-6">
            <p className="text-sm text-muted-foreground">
              Todavía no guardaste ningún producto. Toca el corazón en cualquier producto para
              guardarlo aquí.
            </p>
            <Button href="/">Ver la tienda</Button>
          </CardContent>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.productId}>
              <Card>
                <CardContent className="flex items-center gap-4 py-4">
                  <div className="w-20 shrink-0">
                    {/* `alt=""` in both branches: the product name is
                        printed right beside the photo, and a screen reader
                        hearing it twice per row makes a list of ten products
                        twenty items long. The link carries the accessible
                        name instead. */}
                    {item.available ? (
                      <Link href={`/productos/${item.slug}`} aria-label={item.name}>
                        <ProductImage src={item.imageUrl} alt="" className="rounded-md" />
                      </Link>
                    ) : (
                      <ProductImage src={item.imageUrl} alt="" className="rounded-md opacity-60" />
                    )}
                  </div>

                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    {item.available ? (
                      <Link href={`/productos/${item.slug}`} className="font-medium underline-offset-4 hover:underline">
                        {item.name}
                      </Link>
                    ) : (
                      <span className="font-medium text-muted-foreground">{item.name}</span>
                    )}
                    <span className="text-sm">{formatCOP(item.priceCents)}</span>
                    {item.available ? null : (
                      <Badge variant="secondary" className="w-fit">
                        Ya no está disponible
                      </Badge>
                    )}
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleRemove(item.productId)}
                    disabled={busyId === item.productId}
                    aria-label={`Quitar ${item.name} de favoritos`}
                  >
                    {busyId === item.productId ? <Spinner /> : 'Quitar'}
                  </Button>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
