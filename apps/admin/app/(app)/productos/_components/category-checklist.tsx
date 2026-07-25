'use client';

import { Alert, Spinner } from '@ventia/ui';
import type { Category } from './use-categories';

export interface CategoryChecklistProps {
  categories: Category[] | null;
  loading: boolean;
  loadError: string | null;
  selected: Set<string>;
  onToggle: (id: string) => void;
}

/** Multi-check list of the tenant's categories, bound to a caller-owned
 * `Set<string>` of selected category ids (mapped to `categoryIds` in the
 * product payload). Loading/error/empty states mirror the ones already used
 * by `categorias/page.tsx`. */
export function CategoryChecklist({ categories, loading, loadError, selected, onToggle }: CategoryChecklistProps) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Cargando categorías…
      </div>
    );
  }
  if (loadError) return <Alert variant="error">{loadError}</Alert>;
  if (!categories || categories.length === 0) {
    return <p className="text-sm text-muted-foreground">Aún no tienes categorías. Puedes crearlas desde Categorías.</p>;
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      {categories.map((category) => (
        <label key={category.id} className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={selected.has(category.id)}
            onChange={() => onToggle(category.id)}
            className="h-4 w-4 rounded border-border"
          />
          {category.name}
        </label>
      ))}
    </div>
  );
}
