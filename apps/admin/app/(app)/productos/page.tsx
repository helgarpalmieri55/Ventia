'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Select, Spinner, Table, Tbody, Td, Th, Thead, Tr } from '@ventia/ui';
import { ApiError, apiFetch } from '../../../lib/api';
import { errorMessage } from '../../../lib/errors';
import { formatCOP } from '../../../lib/format';

type ProductStatus = 'draft' | 'active' | 'archived';

/** `''` renders as "Todos" and is never sent as a `status` query param — the
 * API only accepts 'draft' | 'active' | 'archived' (see products.service.ts's
 * ProductListQuery handling), so "show every status" means omitting the
 * param entirely rather than sending an invalid value (recorded decision in
 * the P1c plan's self-review notes). */
type StatusFilter = '' | ProductStatus;

interface ProductListItem {
  id: string;
  name: string;
  priceCents: number;
  stock: number;
  status: ProductStatus;
  images: { url: string }[];
}

interface ProductListResponse {
  items: ProductListItem[];
  total: number;
  page: number;
  pageSize: number;
}

const STATUS_LABEL: Record<ProductStatus, string> = {
  draft: 'Borrador',
  active: 'Activo',
  archived: 'Archivado',
};

const STATUS_BADGE_VARIANT: Record<ProductStatus, 'default' | 'secondary' | 'destructive'> = {
  draft: 'secondary',
  active: 'default',
  archived: 'destructive',
};

const PAGE_SIZE = 20;

/** Products list: search (submit-on-enter/button rather than debounced —
 * keeps state simple per the P1c brief), a status filter, a paginated table,
 * and an es-CO empty state. Rows link to `/productos/[id]` and the "Nuevo
 * producto" button links to `/productos/nuevo` — both are Task 5's pages and
 * 404 until that task lands; linking to them now is intentional (the brief
 * calls this out explicitly) rather than leaving dead buttons. */
export default function ProductosPage() {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [page, setPage] = useState(1);

  const [result, setResult] = useState<ProductListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (status) params.set('status', status);
      params.set('page', String(page));
      params.set('pageSize', String(PAGE_SIZE));
      const response = await apiFetch<ProductListResponse>(`/v1/admin/products?${params.toString()}`);
      setResult(response);
    } catch (e) {
      setLoadError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }, [search, status, page]);

  useEffect(() => {
    void load();
  }, [load]);

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  function handleStatusChange(value: StatusFilter) {
    setStatus(value);
    setPage(1);
  }

  const totalPages = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;
  const isFiltered = search !== '' || status !== '';

  return (
    <Card className="w-full">
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <CardTitle>Productos</CardTitle>
        <a href="/productos/nuevo">
          <Button>Nuevo producto</Button>
        </a>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <form className="flex flex-wrap items-center gap-3" onSubmit={handleSearchSubmit}>
          <Input
            type="search"
            placeholder="Buscar por nombre o SKU"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            className="max-w-xs"
          />
          <Select
            value={status}
            onChange={(event) => handleStatusChange(event.target.value as StatusFilter)}
            className="max-w-40"
            aria-label="Filtrar por estado"
          >
            <option value="">Todos</option>
            <option value="draft">Borrador</option>
            <option value="active">Activo</option>
            <option value="archived">Archivado</option>
          </Select>
          <Button type="submit" variant="secondary">
            Buscar
          </Button>
        </form>

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
          <div className="flex flex-col items-start gap-3 rounded-md border border-dashed border-border p-8">
            <p className="text-sm text-muted-foreground">
              {isFiltered
                ? 'No encontramos productos con esos filtros.'
                : 'Aún no tienes productos. Crea el primero o impórtalos desde un archivo CSV.'}
            </p>
            {isFiltered ? null : (
              <div className="flex gap-3">
                <a href="/productos/nuevo">
                  <Button>Nuevo producto</Button>
                </a>
                <a href="/importar">
                  <Button variant="secondary">Importar CSV</Button>
                </a>
              </div>
            )}
          </div>
        ) : (
          <>
            <Table>
              <Thead>
                <Tr>
                  <Th>
                    <span className="sr-only">Imagen</span>
                  </Th>
                  <Th>Nombre</Th>
                  <Th>Precio</Th>
                  <Th>Stock</Th>
                  <Th>Estado</Th>
                </Tr>
              </Thead>
              <Tbody>
                {result.items.map((product) => (
                  <Tr key={product.id}>
                    <Td className="w-12">
                      {product.images[0] ? (
                        <img src={product.images[0].url} alt="" className="h-10 w-10 rounded object-cover" />
                      ) : (
                        <div className="h-10 w-10 rounded bg-muted" aria-hidden="true" />
                      )}
                    </Td>
                    <Td>
                      <a href={`/productos/${product.id}`} className="font-medium text-foreground hover:underline">
                        {product.name}
                      </a>
                    </Td>
                    <Td>{formatCOP(product.priceCents)}</Td>
                    <Td>{product.stock}</Td>
                    <Td>
                      <Badge variant={STATUS_BADGE_VARIANT[product.status]}>{STATUS_LABEL[product.status]}</Badge>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>

            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Página {result.page} de {totalPages} · {result.total} producto{result.total === 1 ? '' : 's'}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Anterior
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Siguiente
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
