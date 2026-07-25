'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Alert, Card, CardContent, CardHeader, CardTitle, Spinner } from '@ventia/ui';
import { ApiError, apiFetch } from '../../../../lib/api';
import { errorMessage } from '../../../../lib/errors';
import { ArchiveSection } from './_components/archive-section';
import { BaseFieldsForm } from './_components/base-fields-form';
import { ImagesManager } from './_components/images-manager';
import type { Product, ProductImage } from './_components/product-types';
import { StockAdjuster, type StockAdjustTarget } from './_components/stock-adjuster';
import { VariantsEditor } from './_components/variants-editor';

/** Product edit page: loads `GET /v1/admin/products/:id` once, then renders
 * the five sections from the binding contract as independent
 * mostly-self-contained subcomponents, each mutating its own slice of the
 * product through the API and reporting the result back up through a
 * narrow callback so this page can keep a single source of truth for
 * `product` without every section needing the whole object (images/stock
 * only get told what changed, not handed a full re-fetched product). */
export default function ProductoEditPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';

  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await apiFetch<Product>(`/v1/admin/products/${id}`);
      setProduct(result);
    } catch (e) {
      setLoadError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) void load();
  }, [id, load]);

  function handleImageAdded(image: ProductImage) {
    setProduct((prev) =>
      prev ? { ...prev, images: [...prev.images, image].sort((a, b) => a.position - b.position) } : prev,
    );
  }

  function handleImageRemoved(imageId: string) {
    setProduct((prev) => (prev ? { ...prev, images: prev.images.filter((img) => img.id !== imageId) } : prev));
  }

  function handleStockAdjusted(result: { stock: number }, target: StockAdjustTarget) {
    setProduct((prev) => {
      if (!prev) return prev;
      if (target.type === 'product') return { ...prev, stock: result.stock };
      return {
        ...prev,
        variants: prev.variants.map((v) => (v.id === target.variantId ? { ...v, stock: result.stock } : v)),
      };
    });
  }

  function handleArchived() {
    setProduct((prev) => (prev ? { ...prev, status: 'archived' } : prev));
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Cargando producto…
      </div>
    );
  }

  if (loadError || !product) {
    return <Alert variant="error">{loadError ?? 'No encontramos este producto.'}</Alert>;
  }

  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{product.name}</CardTitle>
        </CardHeader>
        <CardContent>
          <BaseFieldsForm product={product} onUpdate={setProduct} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Variantes</CardTitle>
        </CardHeader>
        <CardContent>
          <VariantsEditor
            productId={product.id}
            options={product.options}
            variants={product.variants}
            onUpdate={setProduct}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Imágenes</CardTitle>
        </CardHeader>
        <CardContent>
          <ImagesManager
            productId={product.id}
            images={product.images}
            onImageAdded={handleImageAdded}
            onImageRemoved={handleImageRemoved}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Inventario</CardTitle>
        </CardHeader>
        <CardContent>
          <StockAdjuster
            productId={product.id}
            productStock={product.stock}
            variants={product.variants}
            onAdjusted={handleStockAdjusted}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Archivar</CardTitle>
        </CardHeader>
        <CardContent>
          <ArchiveSection productId={product.id} status={product.status} onArchived={handleArchived} />
        </CardContent>
      </Card>
    </div>
  );
}
