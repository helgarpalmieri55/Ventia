'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Alert,
  Badge,
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
import { ApiError } from '../../../lib/api';
import { errorMessage, fieldErrors } from '../../../lib/errors';
import {
  COLLECTIONS_PATH,
  createCollection,
  deleteCollection,
  listCollections,
  storefrontStatus,
  updateCollection,
  type CollectionSummary,
} from '../../../lib/collections-api';

/**
 * Colecciones: the merchant's curated storefront rows ("Nuevos", "Ofertas"),
 * which are NOT categories — a collection is a shop window the merchant
 * arranged, a category is where a product files. The two live on separate
 * pages for that reason, and this one never mentions nesting.
 *
 * Built on the same three-piece dialog pattern as `categorias/page.tsx`
 * (local form state, a submit handler that clears previous errors, then
 * either an in-place list update or an inline error) so the two catalog pages
 * behave identically under a merchant's hands.
 *
 * The list is ordered exactly as the API returns it (`position`, then name)
 * — that is the order the storefront draws the strips in, and a client-side
 * re-sort would show the merchant an order the shop does not have.
 */
export default function ColeccionesPage() {
  const [collections, setCollections] = useState<CollectionSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setCollections(await listCollections());
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
      // Only the name. The slug is derived server-side and, once it exists,
      // is the address the storefront links to — offering a slug field here
      // invites a merchant to type one before they have any idea what it is
      // for, and changing it later is the thing this page warns about.
      const created = await createCollection({ name: createName.trim() });
      // Appended, matching the server: a new collection goes last.
      setCollections((prev) => (prev ? [...prev, created] : [created]));
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

  // --- visibility toggle (no dialog: it is reversible and its effect is
  // visible in the same row) ---
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  async function handleToggle(collection: CollectionSummary) {
    setRowError(null);
    setTogglingId(collection.id);
    try {
      const updated = await updateCollection(collection.id, { isActive: !collection.isActive });
      setCollections((prev) => prev?.map((c) => (c.id === updated.id ? { ...c, ...updated } : c)) ?? prev);
    } catch (e) {
      setRowError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setTogglingId(null);
    }
  }

  // --- delete confirm dialog ---
  const [deleteTarget, setDeleteTarget] = useState<CollectionSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    setDeleteError(null);
    setDeleteSubmitting(true);
    try {
      await deleteCollection(deleteTarget.id);
      setCollections((prev) => prev?.filter((c) => c.id !== deleteTarget.id) ?? prev);
      setDeleteTarget(null);
    } catch (e) {
      setDeleteError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setDeleteSubmitting(false);
    }
  }

  return (
    <Card className="w-full max-w-4xl">
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <CardTitle>Colecciones</CardTitle>
        <Button onClick={openCreate}>Nueva colección</Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <p className="text-sm text-muted-foreground">
          Una colección es una fila de tu tienda que tú armas y ordenas, como “Nuevos” u “Ofertas”. No reemplaza a
          las categorías: un producto puede estar en varias colecciones y seguir en su categoría de siempre.
        </p>

        {rowError ? <Alert variant="error">{rowError}</Alert> : null}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Cargando colecciones…
          </div>
        ) : loadError ? (
          <div className="flex flex-col gap-3">
            <Alert variant="error">{loadError}</Alert>
            <Button variant="secondary" size="sm" className="self-start" onClick={() => void load()}>
              Reintentar
            </Button>
          </div>
        ) : !collections || collections.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aún no tienes colecciones. Crea la primera para destacar productos en la portada de tu tienda.
          </p>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Nombre</Th>
                <Th>En la tienda</Th>
                <Th>
                  <span className="sr-only">Acciones</span>
                </Th>
              </Tr>
            </Thead>
            <Tbody>
              {collections.map((collection) => {
                const status = storefrontStatus(collection);
                return (
                  <Tr key={collection.id}>
                    <Td className="font-medium text-foreground">
                      {collection.name}
                      <span className="block text-xs font-normal text-muted-foreground">/{collection.slug}</span>
                    </Td>
                    <Td>
                      {/* The label carries the explanation ("8 productos,
                          ninguno disponible") because the strip simply
                          disappears from the storefront in that case — see
                          storefrontStatus. */}
                      <Badge variant={status.visible ? 'default' : 'secondary'}>{status.label}</Badge>
                    </Td>
                    <Td className="flex justify-end gap-2">
                      <Button variant="secondary" size="sm" href={`${COLLECTIONS_PATH}/${collection.id}`}>
                        Curar
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={togglingId === collection.id}
                        onClick={() => void handleToggle(collection)}
                      >
                        {collection.isActive ? 'Ocultar' : 'Mostrar'}
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => setDeleteTarget(collection)}>
                        Eliminar
                      </Button>
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        )}
      </CardContent>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)}>
        <form className="flex flex-col gap-4" onSubmit={handleCreateSubmit}>
          <h2 className="text-lg font-semibold text-foreground">Nueva colección</h2>
          {createError ? <Alert variant="error">{createError}</Alert> : null}
          <FormField label="Nombre" htmlFor="create-collection-name" error={createFieldErrors.name}>
            <Input value={createName} onChange={(event) => setCreateName(event.target.value)} required autoFocus />
          </FormField>
          <p className="text-sm text-muted-foreground">
            Se crea vacía y de última en la portada. Después eliges qué productos van y en qué orden.
          </p>
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

      <Dialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)}>
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-foreground">Eliminar colección</h2>
          <p className="text-sm text-foreground">
            ¿Eliminar <span className="font-medium">{deleteTarget?.name}</span>? Los productos no se eliminan: solo
            dejan de estar en esta colección. Si solo quieres sacarla de la tienda por un tiempo, usa “Ocultar”: así
            conservas el orden que armaste.
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
