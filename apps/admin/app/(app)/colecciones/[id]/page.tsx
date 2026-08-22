'use client';

import { use, useCallback, useEffect, useState, type FormEvent } from 'react';
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
} from '@ventia/ui';
import { ApiError } from '../../../../lib/api';
import { errorMessage, fieldErrors } from '../../../../lib/errors';
import { formatCOP } from '../../../../lib/format';
import {
  COLLECTIONS_PATH,
  getCollection,
  memberWarning,
  moveBy,
  orderChanged,
  removeCollectionProduct,
  setCollectionProducts,
  storefrontStatus,
  updateCollection,
  type CollectionDetail,
  type CollectionMember,
} from '../../../../lib/collections-api';
import { ProductPicker } from '../_components/product-picker';

/**
 * Curating one collection: what is in it, and — the part that only exists
 * here — the order the storefront draws it in.
 *
 * ## Why the order is edited locally and saved once
 *
 * Every "Subir"/"Bajar" click rearranges a local copy; one "Guardar orden"
 * button then sends the finished array to `PUT /:id/products`. The obvious
 * alternative (a request per click) is worse in three ways a merchant would
 * actually feel: it makes moving a product four places four writes to the
 * live storefront, each briefly showing shoppers an arrangement nobody chose;
 * a dropped connection halfway leaves the strip half-reordered; and it turns
 * an undoable local edit into four irreversible ones.
 *
 * The cost of that choice is that a full replace overwrites whatever anyone
 * else changed meanwhile, so it is only ever sent when the merchant really
 * did rearrange something (`orderChanged`) — adding and removing, which staff
 * do far more often, go through the append/remove routes that cannot clobber
 * a colleague's work.
 */
export default function ColeccionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [collection, setCollection] = useState<CollectionDetail | null>(null);
  /** The working copy the arrows rearrange. `collection.products` stays as
   * the server last confirmed it, which is what "¿cambió el orden?" compares
   * against and what a cancel would restore. */
  const [order, setOrder] = useState<CollectionMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const apply = useCallback((detail: CollectionDetail) => {
    setCollection(detail);
    setOrder(detail.products);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      apply(await getCollection(id));
    } catch (e) {
      setLoadError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }, [id, apply]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = collection ? orderChanged(collection.products, order) : false;

  // --- ordering ---
  const [savingOrder, setSavingOrder] = useState(false);

  async function handleSaveOrder() {
    setActionError(null);
    setSavingOrder(true);
    try {
      apply(await setCollectionProducts(id, order.map((m) => m.productId)));
    } catch (e) {
      setActionError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setSavingOrder(false);
    }
  }

  // --- membership ---
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function handleRemove(member: CollectionMember) {
    setActionError(null);
    setRemovingId(member.productId);
    try {
      await removeCollectionProduct(id, member.productId);
      // Re-read rather than splicing locally: the response is 204, and the
      // two counts in the header ("visible con N") come from the server.
      apply(await getCollection(id));
    } catch (e) {
      setActionError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setRemovingId(null);
    }
  }

  // --- rename / slug / visibility ---
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editSlug, setEditSlug] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [editFieldErrors, setEditFieldErrors] = useState<Record<string, string>>({});
  const [editSubmitting, setEditSubmitting] = useState(false);

  function openEdit() {
    if (!collection) return;
    setEditName(collection.name);
    setEditSlug(collection.slug);
    setEditError(null);
    setEditFieldErrors({});
    setEditOpen(true);
  }

  async function handleEditSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!collection) return;
    setEditError(null);
    setEditFieldErrors({});
    setEditSubmitting(true);
    try {
      const slug = editSlug.trim();
      const updated = await updateCollection(collection.id, {
        name: editName.trim(),
        // Only sent when it actually changed. The API leaves the slug alone
        // unless it is asked to move it, and this keeps that true even for a
        // merchant who opened the dialog just to fix a typo in the name.
        ...(slug !== collection.slug ? { slug } : {}),
      });
      apply(updated);
      setEditOpen(false);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'VALIDATION_FAILED') setEditFieldErrors(fieldErrors(e));
        else setEditError(errorMessage(e));
      } else {
        setEditError('Ocurrió un error inesperado. Intenta de nuevo.');
      }
    } finally {
      setEditSubmitting(false);
    }
  }

  const [togglingVisibility, setTogglingVisibility] = useState(false);

  async function handleToggleVisibility() {
    if (!collection) return;
    setActionError(null);
    setTogglingVisibility(true);
    try {
      apply(await updateCollection(collection.id, { isActive: !collection.isActive }));
    } catch (e) {
      setActionError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setTogglingVisibility(false);
    }
  }

  if (loading) {
    return (
      <Card className="w-full max-w-4xl">
        <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Spinner /> Cargando colección…
        </CardContent>
      </Card>
    );
  }

  if (loadError || !collection) {
    return (
      <Card className="w-full max-w-4xl">
        <CardContent className="flex flex-col gap-3 py-6">
          <Alert variant="error">{loadError ?? 'No encontramos esta colección.'}</Alert>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              Reintentar
            </Button>
            <Button variant="ghost" size="sm" href={COLLECTIONS_PATH}>
              Volver a Colecciones
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const status = storefrontStatus(collection);

  return (
    <div className="flex w-full max-w-4xl flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <CardTitle>{collection.name}</CardTitle>
            <span className="text-xs text-muted-foreground">/{collection.slug}</span>
            <Badge variant={status.visible ? 'default' : 'secondary'} className="mt-1 self-start">
              {status.label}
            </Badge>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="secondary" size="sm" onClick={openEdit}>
              Editar
            </Button>
            <Button variant="ghost" size="sm" disabled={togglingVisibility} onClick={() => void handleToggleVisibility()}>
              {collection.isActive ? 'Ocultar' : 'Mostrar'}
            </Button>
            <Button variant="ghost" size="sm" href={COLLECTIONS_PATH}>
              Volver
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {actionError ? <Alert variant="error">{actionError}</Alert> : null}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-foreground">Productos de la colección</h2>
            <div className="flex items-center gap-2">
              {dirty ? <span className="text-xs text-muted-foreground">Orden sin guardar</span> : null}
              <Button
                size="sm"
                variant="secondary"
                disabled={!dirty}
                onClick={() => setOrder(collection.products)}
              >
                Descartar
              </Button>
              <Button size="sm" disabled={!dirty || savingOrder} onClick={() => void handleSaveOrder()}>
                {savingOrder ? 'Guardando…' : 'Guardar orden'}
              </Button>
            </div>
          </div>

          {order.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Esta colección está vacía, así que no aparece en la tienda. Agrega productos abajo.
            </p>
          ) : (
            <ol className="flex flex-col gap-2">
              {order.map((member, index) => {
                const warning = memberWarning(member.status);
                return (
                  <li
                    key={member.productId}
                    className="flex items-center gap-3 rounded-md border border-border p-3"
                  >
                    <span className="w-6 shrink-0 text-sm text-muted-foreground">{index + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{member.name}</p>
                      <p className="text-xs text-muted-foreground">{formatCOP(member.priceCents)}</p>
                      {/* The one thing this page exists to make visible: a
                          member the shopper cannot see. The strip silently
                          shrinks in the storefront, so it has to be loud
                          here. */}
                      {warning ? (
                        <Badge variant="secondary" className="mt-1">
                          {warning}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Subir ${member.name}`}
                        disabled={index === 0}
                        onClick={() => setOrder((prev) => moveBy(prev, index, -1))}
                      >
                        ↑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Bajar ${member.name}`}
                        disabled={index === order.length - 1}
                        onClick={() => setOrder((prev) => moveBy(prev, index, 1))}
                      >
                        ↓
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={removingId === member.productId}
                        onClick={() => void handleRemove(member)}
                      >
                        Quitar
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </CardContent>
      </Card>

      <ProductPicker
        collectionId={collection.id}
        alreadyIn={new Set(collection.products.map((m) => m.productId))}
        onAdded={apply}
      />

      <Dialog open={editOpen} onClose={() => setEditOpen(false)}>
        <form className="flex flex-col gap-4" onSubmit={handleEditSubmit}>
          <h2 className="text-lg font-semibold text-foreground">Editar colección</h2>
          {editError ? <Alert variant="error">{editError}</Alert> : null}
          <FormField label="Nombre" htmlFor="edit-collection-name" error={editFieldErrors.name}>
            <Input value={editName} onChange={(event) => setEditName(event.target.value)} required autoFocus />
          </FormField>
          <FormField label="Dirección (URL)" htmlFor="edit-collection-slug" error={editFieldErrors.slug}>
            <Input value={editSlug} onChange={(event) => setEditSlug(event.target.value)} required />
          </FormField>
          {/* Stated where the merchant is about to do it, not in a help page:
              nothing in this platform redirects an old address, so a changed
              slug breaks every link already published to it. */}
          <p className="text-sm text-muted-foreground">
            Cambiar el nombre no cambia la dirección. Si cambias la dirección, los enlaces que ya compartiste a la
            anterior dejan de funcionar.
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setEditOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={editSubmitting}>
              {editSubmitting ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
