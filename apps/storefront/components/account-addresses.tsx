'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Spinner } from '@ventia/ui';
import {
  AccountApiError,
  createAddress,
  deleteAddress,
  fetchMyAddresses,
  setDefaultAddress,
  updateAddress,
  type SavedAddress,
} from '../lib/account-api';
import {
  addressCardTitle,
  addressFormToInput,
  addressLines,
  addressToForm,
  type AddressFormState,
} from '../lib/account-addresses';
import { useShopper } from '../lib/shopper-context';
import { AccountAddressForm } from './account-address-form';

const LOAD_ERROR = 'No pudimos cargar tus direcciones. Intenta de nuevo.';
const SAVE_ERROR = 'No pudimos guardar la dirección. Intenta de nuevo.';
const DELETE_ERROR = 'No pudimos eliminar la dirección. Intenta de nuevo.';
const DEFAULT_ERROR = 'No pudimos cambiar tu dirección por defecto. Intenta de nuevo.';
/** The API's cap, phrased as the shopper's problem to solve rather than as a
 * system limit they cannot act on. */
const TOO_MANY_ERROR = 'Ya guardaste el máximo de direcciones. Elimina una para agregar otra.';
/** An address that vanished between this page loading and the shopper acting
 * on it — another tab, another device. Says what happened rather than
 * "algo salió mal", because the list on screen is now simply stale. */
const GONE_ERROR = 'Esa dirección ya no existe. Actualizamos tu lista.';

function saveErrorMessage(err: unknown): string {
  if (err instanceof AccountApiError) {
    if (err.code === 'TOO_MANY_ADDRESSES') return TOO_MANY_ERROR;
    if (err.code === 'ADDRESS_NOT_FOUND') return GONE_ERROR;
  }
  return SAVE_ERROR;
}

type Mode = { kind: 'list' } | { kind: 'new' } | { kind: 'edit'; id: string };

/**
 * `/cuenta/direcciones` — the shopper's saved addresses.
 *
 * ## Signed out is a redirect, not an error
 *
 * Identical to `AccountArea`'s: there is nothing here for a guest, and the
 * redirect waits for `loading` to settle so a signed-in shopper is never
 * bounced off their own page while `/me` is still in flight.
 *
 * ## The list is re-read from the server after every write, not patched
 *
 * Each mutation returns only the row it touched, and two of them change rows
 * they do not return: promoting an address DEMOTES the previous default, and
 * creating the first one is made default by the server whatever the form
 * asked. Patching local state from a single returned row would therefore
 * leave two rows both showing "Por defecto" — and the one checkout actually
 * pre-fills from would be whichever the shopper did not see. Re-reading is a
 * cheap request against a list capped at 20.
 */
export function AccountAddresses() {
  const router = useRouter();
  const { shopper, loading: sessionLoading } = useShopper();

  const [addresses, setAddresses] = React.useState<SavedAddress[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<Mode>({ kind: 'list' });
  const [formError, setFormError] = React.useState<string | null>(null);
  const [rowError, setRowError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!sessionLoading && !shopper) router.replace('/cuenta/entrar');
  }, [sessionLoading, shopper, router]);

  const reload = React.useCallback(async () => {
    const rows = await fetchMyAddresses();
    setAddresses(rows);
  }, []);

  React.useEffect(() => {
    // Deliberately does not run for a guest: `fetchMyAddresses` would 401,
    // and the redirect above is already taking them somewhere useful. A
    // guaranteed-failing request would only put an error banner in front of
    // someone on their way out.
    if (sessionLoading || !shopper) return;
    let cancelled = false;
    setLoading(true);
    fetchMyAddresses()
      .then((rows) => {
        if (!cancelled) setAddresses(rows);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[account] failed to load addresses', err);
        setLoadError(LOAD_ERROR);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionLoading, shopper]);

  const editing =
    mode.kind === 'edit' ? (addresses?.find((a) => a.id === mode.id) ?? null) : null;

  async function handleCreate(form: AddressFormState) {
    setFormError(null);
    try {
      await createAddress({
        label: form.label.trim(),
        address: addressFormToInput(form),
        // Sent only when asked for. The API makes the FIRST address default
        // regardless, so sending `false` here would be a claim the server
        // correctly ignores — but sending it would still read, to anyone
        // debugging, as this UI having asked for something it did not get.
        ...(form.isDefault ? { isDefault: true } : {}),
      });
      await reload();
      setMode({ kind: 'list' });
    } catch (err) {
      console.error('[account] failed to create address', err);
      setFormError(saveErrorMessage(err));
    }
  }

  async function handleUpdate(id: string, form: AddressFormState) {
    setFormError(null);
    try {
      // `label` goes as `null` when blank, never `''`: the API's schema takes
      // null as "clear it" and rejects the empty string, so a shopper
      // deleting the label text has to send the former.
      const label = form.label.trim();
      await updateAddress(id, { label: label.length > 0 ? label : null, address: addressFormToInput(form) });
      // A promotion is a separate call — `PATCH` has no `isDefault`, because
      // making one default demotes another and the API keeps that in its own
      // clear-then-set route. Only ever called to PROMOTE: there is no
      // "un-default" route, and inventing one by promoting some other address
      // would pre-fill checkout with one the shopper never chose.
      if (form.isDefault && !editingWasDefault(addresses, id)) await setDefaultAddress(id);
      await reload();
      setMode({ kind: 'list' });
    } catch (err) {
      console.error('[account] failed to update address', err);
      setFormError(saveErrorMessage(err));
    }
  }

  async function handleDelete(id: string) {
    setRowError(null);
    setBusyId(id);
    try {
      await deleteAddress(id);
      await reload();
    } catch (err) {
      console.error('[account] failed to delete address', err);
      // A 404 means it is already gone, which is the state the shopper asked
      // for — so the list is refreshed and the message says so, rather than
      // reporting a failure for an operation whose goal was reached.
      setRowError(err instanceof AccountApiError && err.code === 'ADDRESS_NOT_FOUND' ? GONE_ERROR : DELETE_ERROR);
      await reload().catch(() => undefined);
    } finally {
      setBusyId(null);
    }
  }

  async function handleSetDefault(id: string) {
    setRowError(null);
    setBusyId(id);
    try {
      await setDefaultAddress(id);
      await reload();
    } catch (err) {
      console.error('[account] failed to set default address', err);
      setRowError(err instanceof AccountApiError && err.code === 'ADDRESS_NOT_FOUND' ? GONE_ERROR : DEFAULT_ERROR);
      await reload().catch(() => undefined);
    } finally {
      setBusyId(null);
    }
  }

  if (sessionLoading || !shopper) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-8">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Cargando…
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Mis direcciones</h1>
        <Link href="/cuenta" className="text-sm underline underline-offset-4">
          Volver a mi cuenta
        </Link>
      </div>

      {mode.kind === 'new' ? (
        <Card>
          <CardHeader>
            <CardTitle>Nueva dirección</CardTitle>
          </CardHeader>
          <CardContent>
            <AccountAddressForm
              idPrefix="new-"
              submitLabel="Guardar dirección"
              // Nothing to ask when this is the first one: the API makes it
              // the default whatever the box says.
              showDefaultToggle={(addresses?.length ?? 0) > 0}
              firstAddressNotice={(addresses?.length ?? 0) === 0}
              error={formError}
              onSubmit={handleCreate}
              onCancel={() => {
                setFormError(null);
                setMode({ kind: 'list' });
              }}
            />
          </CardContent>
        </Card>
      ) : mode.kind === 'edit' && editing ? (
        <Card>
          <CardHeader>
            <CardTitle>Editar dirección</CardTitle>
          </CardHeader>
          <CardContent>
            <AccountAddressForm
              idPrefix="edit-"
              submitLabel="Guardar cambios"
              initial={addressToForm(editing)}
              // An address that already IS the default has nothing to offer
              // here: there is no route to un-set one, so a checkbox the
              // shopper could untick would do nothing.
              showDefaultToggle={!editing.isDefault}
              error={formError}
              onSubmit={(form) => handleUpdate(editing.id, form)}
              onCancel={() => {
                setFormError(null);
                setMode({ kind: 'list' });
              }}
            />
          </CardContent>
        </Card>
      ) : (
        <>
          {loadError ? <Alert variant="error">{loadError}</Alert> : null}
          {rowError ? <Alert variant="error">{rowError}</Alert> : null}

          {loading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Cargando tus direcciones…
            </p>
          ) : !addresses || addresses.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-start gap-3 py-6">
                <p className="text-sm text-muted-foreground">
                  Todavía no guardaste ninguna dirección. Guarda una y la usaremos para llenar tus
                  datos al pagar.
                </p>
                <Button onClick={() => setMode({ kind: 'new' })}>Agregar dirección</Button>
              </CardContent>
            </Card>
          ) : (
            <>
              <ul className="flex flex-col gap-3">
                {addresses.map((saved) => (
                  <li key={saved.id}>
                    <AddressCard
                      saved={saved}
                      busy={busyId === saved.id}
                      onEdit={() => {
                        setFormError(null);
                        setMode({ kind: 'edit', id: saved.id });
                      }}
                      onDelete={() => void handleDelete(saved.id)}
                      onSetDefault={() => void handleSetDefault(saved.id)}
                    />
                  </li>
                ))}
              </ul>
              <Button className="self-start" onClick={() => setMode({ kind: 'new' })}>
                Agregar dirección
              </Button>
            </>
          )}
        </>
      )}
    </main>
  );
}

/** Whether the row being edited is already the default — read from the list
 * rather than from the form, because the form's checkbox is what the shopper
 * WANTS and this is what currently IS. Promoting an address that is already
 * default is harmless on the API but would be a pointless second round trip
 * on every plain edit of the default address. */
function editingWasDefault(addresses: SavedAddress[] | null, id: string): boolean {
  return addresses?.find((a) => a.id === id)?.isDefault ?? false;
}

function AddressCard({
  saved,
  busy,
  onEdit,
  onDelete,
  onSetDefault,
}: {
  saved: SavedAddress;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onSetDefault: () => void;
}) {
  const [confirming, setConfirming] = React.useState(false);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{addressCardTitle(saved)}</span>
          {saved.isDefault ? <Badge>Por defecto</Badge> : null}
        </div>

        <div className="text-sm text-muted-foreground">
          <p>{saved.address.nombreCompleto}</p>
          <p>{saved.address.telefono}</p>
          {addressLines(saved.address).map((line, i) => (
            <p key={i}>{line}</p>
          ))}
          {saved.address.notas ? <p className="italic">{saved.address.notas}</p> : null}
        </div>

        {confirming ? (
          <div className="flex flex-col gap-2 rounded-md border border-border p-3">
            <p className="text-sm">
              ¿Eliminar esta dirección? {saved.isDefault ? 'Es tu dirección por defecto: al pagar tendrás que escribir una de nuevo.' : null}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="destructive" size="sm" onClick={onDelete} disabled={busy}>
                {busy ? (
                  <>
                    <Spinner /> Eliminando…
                  </>
                ) : (
                  'Sí, eliminar'
                )}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
                Cancelar
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onEdit} disabled={busy}>
              Editar
            </Button>
            {/* No "quitar por defecto": the API has no route to un-set one,
                and there is deliberately none — an account with saved
                addresses and no default pre-fills nothing, which reads as the
                feature being broken. */}
            {saved.isDefault ? null : (
              <Button variant="secondary" size="sm" onClick={onSetDefault} disabled={busy}>
                {busy ? (
                  <>
                    <Spinner /> Guardando…
                  </>
                ) : (
                  'Usar por defecto'
                )}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setConfirming(true)} disabled={busy}>
              Eliminar
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
