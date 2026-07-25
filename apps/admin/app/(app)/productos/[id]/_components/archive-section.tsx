'use client';

import { useState } from 'react';
import { Alert, Button, Dialog } from '@ventia/ui';
import { ApiError, apiFetch } from '../../../../../lib/api';
import { errorMessage } from '../../../../../lib/errors';
import type { ProductStatus } from '../../../../../lib/product-labels';

export interface ArchiveSectionProps {
  productId: string;
  status: ProductStatus;
  onArchived: () => void;
}

/** Section 5 of the edit page: `DELETE /:id` sets `status: 'archived'`
 * server-side (it doesn't hard-delete the row) — confirmed via a dialog
 * since it's a one-click action with no separate "are you sure" field to
 * type. Un-archiving is NOT a separate action here: it's just picking a
 * non-archived value in the "Estado" select in the base fields form above
 * and saving (see `base-fields-form.tsx`'s comment on the resulting
 * `PLAN_LIMIT_EXCEEDED` possibility) — this section only ever needs to show
 * the one-way archive action or a note pointing back at that select. */
export function ArchiveSection({ productId, status, onArchived }: ArchiveSectionProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === 'archived') {
    return (
      <p className="text-sm text-muted-foreground">
        Este producto está archivado. Para reactivarlo, cambia el Estado en los datos básicos y guarda los cambios.
      </p>
    );
  }

  async function handleConfirm() {
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch<void>(`/v1/admin/products/${productId}`, { method: 'DELETE' });
      onArchived();
      setOpen(false);
    } catch (e) {
      setError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Button variant="destructive" size="sm" className="self-start" onClick={() => setOpen(true)}>
        Archivar producto
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)}>
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-foreground">Archivar producto</h2>
          <p className="text-sm text-foreground">
            El producto dejará de estar visible en la tienda. Podrás reactivarlo después cambiando su estado.
          </p>
          {error ? <Alert variant="error">{error}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button variant="destructive" disabled={submitting} onClick={() => void handleConfirm()}>
              {submitting ? 'Archivando…' : 'Archivar'}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
