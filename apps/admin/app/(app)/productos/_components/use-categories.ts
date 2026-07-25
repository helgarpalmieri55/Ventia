'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiFetch } from '../../../../lib/api';
import { errorMessage } from '../../../../lib/errors';

export interface Category {
  id: string;
  name: string;
  slug: string;
  position: number;
}

/** Loads the tenant's category list (`GET /v1/admin/categories`, the same
 * endpoint `categorias/page.tsx` uses) for the create/edit product forms'
 * category checklist — factored out since both pages need the identical
 * load-on-mount + retry behavior. */
export function useCategories() {
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await apiFetch<Category[]>('/v1/admin/categories');
      setCategories(result);
    } catch (e) {
      setLoadError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { categories, loading, loadError, reload: load };
}
