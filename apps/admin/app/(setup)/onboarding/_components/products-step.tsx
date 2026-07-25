'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle } from '@ventia/ui';
import { ApiError, apiFetch } from '../../../../lib/api';
import { errorMessage } from '../../../../lib/errors';

interface ProductListResponse {
  total: number;
}

export interface ProductsStepProps {
  onDone: () => void;
}

/** `products` step: no data of its own — the merchant adds products through
 * the regular catalog pages (`/productos`), then comes back here and
 * confirms with "Ya agregué mis productos", which just marks the wizard step
 * done (`PATCH /v1/admin/onboarding { step: 'products' }`). The live count
 * (`GET /v1/admin/products?pageSize=1` for its `total`) is shown so the
 * merchant doesn't have to guess whether the catalog page's changes saved. */
export function ProductsStep({ onDone }: ProductsStepProps) {
  const [total, setTotal] = useState<number | null>(null);
  const [countError, setCountError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadCount = useCallback(async () => {
    setCountError(null);
    try {
      const result = await apiFetch<ProductListResponse>('/v1/admin/products?pageSize=1');
      setTotal(result.total);
    } catch (e) {
      setCountError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    }
  }, []);

  useEffect(() => {
    void loadCount();
  }, [loadCount]);

  async function handleContinue() {
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch('/v1/admin/onboarding', {
        method: 'PATCH',
        body: JSON.stringify({ step: 'products' }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agrega tus productos</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Ve a la sección de productos y agrega al menos uno como activo. Puedes crearlos uno por uno o importar un
          CSV con varios a la vez.
        </p>
        {countError ? <Alert variant="error">{countError}</Alert> : null}
        {total !== null ? (
          <p className="text-sm text-foreground">
            Tienes <span className="font-semibold">{total}</span> {total === 1 ? 'producto' : 'productos'} en tu
            catálogo.
          </p>
        ) : null}
        <a href="/productos" className="text-sm text-primary underline">
          Ir a Productos
        </a>
        <Button variant="secondary" size="sm" className="self-start" onClick={() => void loadCount()}>
          Actualizar contador
        </Button>
        {error ? <Alert variant="error">{error}</Alert> : null}
        <Button onClick={() => void handleContinue()} disabled={submitting} className="self-start">
          {submitting ? 'Guardando…' : 'Ya agregué mis productos'}
        </Button>
      </CardContent>
    </Card>
  );
}
