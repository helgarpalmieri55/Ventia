'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  FormField,
  Input,
  Spinner,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '@ventia/ui';
import { ApiError, apiFetch } from '../../../lib/api';
import { errorMessage, fieldErrors } from '../../../lib/errors';

interface Category {
  id: string;
  name: string;
  slug: string;
  position: number;
}

/** Categories list + create/rename/delete dialogs, all built on the same
 * three-piece pattern: local text state for the form, a submit handler that
 * clears previous errors, calls the API, and either updates `categories` in
 * place or surfaces the error (VALIDATION_FAILED -> per-field message via
 * `fieldErrors`; anything else, notably 409 SLUG_TAKEN -> `errorMessage`
 * shown inline in the dialog). */
export default function CategoriasPage() {
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // Ordered exactly as the API returns it (CategoriesController.list:
      // `orderBy: [{ position: 'asc' }, { name: 'asc' }]`) — no client-side
      // re-sort.
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

  // --- create dialog ---
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [createFieldErrors, setCreateFieldErrors] = useState<Record<string, string>>({});
  const [createSubmitting, setCreateSubmitting] = useState(false);

  function openCreate() {
    setCreateName('');
    setCreateError(null);
    setCreateFieldErrors({});
    setCreateOpen(true);
  }

  async function handleCreateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateError(null);
    setCreateFieldErrors({});
    setCreateSubmitting(true);
    try {
      const category = await apiFetch<Category>('/v1/admin/categories', {
        method: 'POST',
        body: JSON.stringify({ name: createName.trim() }),
      });
      setCategories((prev) => (prev ? [...prev, category] : [category]));
      setCreateOpen(false);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'VALIDATION_FAILED') setCreateFieldErrors(fieldErrors(e));
        else setCreateError(errorMessage(e));
      } else {
        setCreateError('Ocurrió un error inesperado. Intenta de nuevo.');
      }
    } finally {
      setCreateSubmitting(false);
    }
  }

  // --- rename dialog ---
  const [renameTarget, setRenameTarget] = useState<Category | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameFieldErrors, setRenameFieldErrors] = useState<Record<string, string>>({});
  const [renameSubmitting, setRenameSubmitting] = useState(false);

  function openRename(category: Category) {
    setRenameTarget(category);
    setRenameName(category.name);
    setRenameError(null);
    setRenameFieldErrors({});
  }

  async function handleRenameSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renameTarget) return;
    setRenameError(null);
    setRenameFieldErrors({});
    setRenameSubmitting(true);
    try {
      const updated = await apiFetch<Category>(`/v1/admin/categories/${renameTarget.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: renameName.trim() }),
      });
      setCategories((prev) => prev?.map((c) => (c.id === updated.id ? updated : c)) ?? prev);
      setRenameTarget(null);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'VALIDATION_FAILED') setRenameFieldErrors(fieldErrors(e));
        else setRenameError(errorMessage(e));
      } else {
        setRenameError('Ocurrió un error inesperado. Intenta de nuevo.');
      }
    } finally {
      setRenameSubmitting(false);
    }
  }

  // --- delete confirm dialog ---
  const [deleteTarget, setDeleteTarget] = useState<Category | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  function openDelete(category: Category) {
    setDeleteTarget(category);
    setDeleteError(null);
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    setDeleteError(null);
    setDeleteSubmitting(true);
    try {
      await apiFetch<void>(`/v1/admin/categories/${deleteTarget.id}`, { method: 'DELETE' });
      setCategories((prev) => prev?.filter((c) => c.id !== deleteTarget.id) ?? prev);
      setDeleteTarget(null);
    } catch (e) {
      setDeleteError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setDeleteSubmitting(false);
    }
  }

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <CardTitle>Categorías</CardTitle>
        <Button onClick={openCreate}>Nueva categoría</Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Cargando categorías…
          </div>
        ) : loadError ? (
          <div className="flex flex-col gap-3">
            <Alert variant="error">{loadError}</Alert>
            <Button variant="secondary" size="sm" className="self-start" onClick={() => void load()}>
              Reintentar
            </Button>
          </div>
        ) : !categories || categories.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aún no tienes categorías. Crea la primera para organizar tu catálogo.
          </p>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Nombre</Th>
                <Th>
                  <span className="sr-only">Acciones</span>
                </Th>
              </Tr>
            </Thead>
            <Tbody>
              {categories.map((category) => (
                <Tr key={category.id}>
                  <Td className="font-medium text-foreground">{category.name}</Td>
                  <Td className="flex justify-end gap-2">
                    <Button variant="secondary" size="sm" onClick={() => openRename(category)}>
                      Renombrar
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => openDelete(category)}>
                      Eliminar
                    </Button>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </CardContent>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)}>
        <form className="flex flex-col gap-4" onSubmit={handleCreateSubmit}>
          <h2 className="text-lg font-semibold text-foreground">Nueva categoría</h2>
          {createError ? <Alert variant="error">{createError}</Alert> : null}
          <FormField label="Nombre" htmlFor="create-category-name" error={createFieldErrors.name}>
            <Input
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              required
              autoFocus
            />
          </FormField>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={createSubmitting}>
              {createSubmitting ? 'Creando…' : 'Crear'}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={renameTarget !== null} onClose={() => setRenameTarget(null)}>
        <form className="flex flex-col gap-4" onSubmit={handleRenameSubmit}>
          <h2 className="text-lg font-semibold text-foreground">Renombrar categoría</h2>
          {renameError ? <Alert variant="error">{renameError}</Alert> : null}
          <FormField label="Nombre" htmlFor="rename-category-name" error={renameFieldErrors.name}>
            <Input
              value={renameName}
              onChange={(event) => setRenameName(event.target.value)}
              required
              autoFocus
            />
          </FormField>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setRenameTarget(null)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={renameSubmitting}>
              {renameSubmitting ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)}>
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-foreground">Eliminar categoría</h2>
          <p className="text-sm text-foreground">
            ¿Eliminar <span className="font-medium">{deleteTarget?.name}</span>? Los productos no se eliminan: solo
            se quitan de esta categoría.
          </p>
          {deleteError ? <Alert variant="error">{deleteError}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
              Cancelar
            </Button>
            <Button variant="destructive" disabled={deleteSubmitting} onClick={() => void handleDeleteConfirm()}>
              {deleteSubmitting ? 'Eliminando…' : 'Eliminar'}
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}
