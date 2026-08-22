'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Spinner } from '@ventia/ui';
import { ApiError, apiFetch } from '../../../../lib/api';
import { errorMessage } from '../../../../lib/errors';
import { formatCOP } from '../../../../lib/format';
import { addCollectionProducts, type CollectionDetail, type ProductStatus } from '../../../../lib/collections-api';

interface ProductListItem {
  id: string;
  name: string;
  priceCents: number;
  status: ProductStatus;
}

interface ProductListResponse {
  items: ProductListItem[];
  total: number;
  page: number;
  pageSize: number;
}

const PAGE_SIZE = 20;

const STATUS_LABEL: Record<ProductStatus, string> = {
  draft: 'Borrador',
  active: 'Activo',
  archived: 'Archivado',
};

/**
 * Adds products to a collection.
 *
 * Search-on-submit over `GET /v1/admin/products`, the same endpoint (and the
 * same non-debounced form) the Productos list uses, so a merchant searching
 * here gets exactly the results they would get there.
 *
 * Two deliberate decisions:
 *
 *  - **Draft and archived products are offered, labelled.** The API accepts
 *    them (a merchant assembling next month's sale curates before
 *    publishing), and hiding them here would make "why can't I find my
 *    product?" unanswerable. The label is what stops it being a trap: the
 *    storefront will not show them until they are published.
 *  - **Adding appends, and never resends the whole list.** `POST
 *    /:id/products` cannot clobber a row somebody else added while this panel
 *    was open — unlike the PUT the ordering controls use.
 */
export function ProductPicker({
  collectionId,
  alreadyIn,
  onAdded,
}: {
  collectionId: string;
  /** Product ids already in the collection: shown as "Ya está" rather than
   * hidden, so a merchant searching for a product they added last week is not
   * left wondering whether it exists. */
  alreadyIn: Set<string>;
  onAdded: (detail: CollectionDetail) => void;
}) {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [result, setResult] = useState<ProductListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({ page: '1', pageSize: String(PAGE_SIZE) });
      if (search) params.set('search', search);
      setResult(await apiFetch<ProductListResponse>(`/v1/admin/products?${params.toString()}`));
    } catch (e) {
      setLoadError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    void load();
  }, [load]);

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearch(searchInput.trim());
  }

  function toggle(productId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  }

  async function handleAdd() {
    if (selected.size === 0) return;
    setAddError(null);
    setAdding(true);
    try {
      onAdded(await addCollectionProducts(collectionId, [...selected]));
      // Cleared only on success: a failed add leaves the merchant's selection
      // intact so they can retry without rebuilding it.
      setSelected(new Set());
    } catch (e) {
      setAddError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setAdding(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <CardTitle>Agregar productos</CardTitle>
        <Button size="sm" disabled={selected.size === 0 || adding} onClick={() => void handleAdd()}>
          {adding ? 'Agregando…' : `Agregar${selected.size > 0 ? ` (${selected.size})` : ''}`}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form className="flex flex-wrap items-center gap-3" onSubmit={handleSearchSubmit}>
          <Input
            type="search"
            placeholder="Buscar por nombre o SKU"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            className="max-w-xs"
            aria-label="Buscar productos"
          />
          <Button type="submit" variant="secondary" size="sm">
            Buscar
          </Button>
        </form>

        {addError ? <Alert variant="error">{addError}</Alert> : null}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Cargando productos…
          </div>
        ) : loadError ? (
          <div className="flex flex-col gap-3">
            <Alert variant="error">{loadError}</Alert>
            <Button variant="secondary" size="sm" className="self-start" onClick={() => void load()}>
              Reintentar
            </Button>
          </div>
        ) : !result || result.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {search ? 'Ningún producto coincide con esa búsqueda.' : 'Aún no tienes productos que agregar.'}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {result.items.map((product) => {
              const inCollection = alreadyIn.has(product.id);
              return (
                <label
                  key={product.id}
                  className="flex items-center gap-3 rounded-md border border-border p-3 text-sm"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-border"
                    checked={selected.has(product.id)}
                    disabled={inCollection}
                    onChange={() => toggle(product.id)}
                  />
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">{product.name}</span>
                  <span className="shrink-0 text-muted-foreground">{formatCOP(product.priceCents)}</span>
                  {product.status !== 'active' ? (
                    <Badge variant="secondary">{STATUS_LABEL[product.status]}</Badge>
                  ) : null}
                  {inCollection ? <Badge>Ya está</Badge> : null}
                </label>
              );
            })}
            {result.total > result.items.length ? (
              <p className="text-xs text-muted-foreground">
                Mostrando {result.items.length} de {result.total}. Usa la búsqueda para encontrar el resto.
              </p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
