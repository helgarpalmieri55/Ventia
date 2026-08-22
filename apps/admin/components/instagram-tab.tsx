'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Dialog, FormField, Input, Spinner, type BadgeVariant } from '@ventia/ui';
import { ApiError } from '../lib/api';
import { errorMessage, fieldErrors } from '../lib/errors';
import { formatDateCO } from '../lib/format';
import {
  BLANK_INSTAGRAM_FORM,
  INSTAGRAM_PROVIDER_LABEL,
  buildInstagramConnectPayload,
  connectInstagramAccount,
  disconnectInstagramAccount,
  instagramCallbackUrl,
  instagramStatusLabel,
  listInstagramAccounts,
  setInstagramAccountStatus,
  type InstagramAccount,
  type InstagramAccountsResponse,
  type InstagramFormFields,
  type InstagramProviderId,
} from '../lib/instagram-api';

/**
 * Pestaña de Instagram: conectar la cuenta de la tienda y manejar las que ya
 * están conectadas.
 *
 * No recibe props, al contrario que sus pestañas hermanas: nada de esto vive
 * en `GET /v1/admin/settings` —es su propio recurso, solo para el dueño y con
 * su propia puerta de plan—, así que pasarle `settings`/`onSaved` sería darle
 * estado que no debe escribir.
 *
 * La lista se pinta aunque el plan no incluya el canal. Una tienda que bajó de
 * plan sigue teniendo cuentas vivas que querrá ver y desconectar; lo que
 * desaparece con el plan es el FORMULARIO, porque el `POST` respondería 402.
 */
export function InstagramTab() {
  const [data, setData] = useState<InstagramAccountsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setData(await listInstagramAccounts());
    } catch (e) {
      setLoadError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Funde la fila que devolvió un POST/PATCH en la lista POR ID en vez de
   * añadirla: reconectar una cuenta que esta tienda ya tiene actualiza la fila
   * existente en el servidor y devuelve ese mismo id, así que añadirla le
   * mostraría al comerciante dos filas para una sola cuenta. */
  const upsertAccount = useCallback((account: InstagramAccount) => {
    setData((prev) => {
      if (!prev) return prev;
      const exists = prev.items.some((item) => item.id === account.id);
      return {
        ...prev,
        items: exists ? prev.items.map((item) => (item.id === account.id ? account : item)) : [...prev.items, account],
      };
    });
  }, []);

  const removeAccount = useCallback((id: string) => {
    setData((prev) => (prev ? { ...prev, items: prev.items.filter((item) => item.id !== id) } : prev));
  }, []);

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Cargando tus cuentas de Instagram…
      </p>
    );
  }

  if (loadError || !data) {
    return (
      <div className="flex flex-col gap-3">
        <Alert variant="error">{loadError ?? 'Ocurrió un error inesperado. Intenta de nuevo.'}</Alert>
        <Button variant="secondary" size="sm" className="self-start" onClick={() => void load()}>
          Reintentar
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <AccountsList
        items={data.items}
        callbackBaseUrl={data.callbackBaseUrl}
        channelEnabled={data.channelEnabled}
        onUpdated={upsertAccount}
        onRemoved={removeAccount}
      />

      <div className="border-t border-border pt-6">
        {data.channelEnabled ? (
          <ConnectSection callbackBaseUrl={data.callbackBaseUrl} onConnected={upsertAccount} />
        ) : (
          <UpgradePrompt hasAccounts={data.items.length > 0} />
        )}
      </div>
    </div>
  );
}

/** Se muestra EN LUGAR del formulario cuando `TenantLimits.instagramChannel`
 * es falso, que es lo que le pasa a una tienda en Emprende. Un formulario que
 * solo puede acabar en 402 es peor que ningún formulario: le cuesta al
 * comerciante una tanda de teclear credenciales de Meta para enterarse de algo
 * que ya sabíamos antes de pintar la página. */
function UpgradePrompt({ hasAccounts }: { hasAccounts: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">Conectar una cuenta</h3>
      <Alert variant="warning">
        <p>
          Tu plan actual no incluye el canal de Instagram, así que todavía no puedes conectar una cuenta. El plan Crece
          lo incluye, y con él tus clientes te escriben por mensajes directos y el asistente les responde.
        </p>
        {hasAccounts ? (
          <p className="mt-2">
            Las cuentas que ya tienes conectadas siguen en la lista, pero no reciben mensajes mientras tu plan no
            incluya el canal.
          </p>
        ) : null}
      </Alert>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Cuentas conectadas                                                         */
/* -------------------------------------------------------------------------- */

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  connected: 'default',
  disabled: 'destructive',
  pending: 'secondary',
};

function AccountsList({
  items,
  callbackBaseUrl,
  channelEnabled,
  onUpdated,
  onRemoved,
}: {
  items: InstagramAccount[];
  callbackBaseUrl: string;
  channelEnabled: boolean;
  onUpdated: (account: InstagramAccount) => void;
  onRemoved: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-sm font-medium text-foreground">Tus cuentas conectadas</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {channelEnabled
            ? 'Todavía no has conectado ninguna cuenta. Conéctala abajo para que tus clientes te escriban por Instagram.'
            : 'Todavía no has conectado ninguna cuenta.'}
        </p>
      ) : (
        items.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            callbackBaseUrl={callbackBaseUrl}
            onUpdated={onUpdated}
            onRemoved={onRemoved}
          />
        ))
      )}
    </div>
  );
}

function AccountRow({
  account,
  callbackBaseUrl,
  onUpdated,
  onRemoved,
}: {
  account: InstagramAccount;
  callbackBaseUrl: string;
  onUpdated: (account: InstagramAccount) => void;
  onRemoved: (id: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const disabled = account.status === 'disabled';

  async function handleToggle() {
    setError(null);
    setSubmitting(true);
    try {
      onUpdated(await setInstagramAccountStatus(account.id, disabled ? 'connected' : 'disabled'));
    } catch (e) {
      setError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDisconnect() {
    setError(null);
    setSubmitting(true);
    try {
      await disconnectInstagramAccount(account.id);
      setConfirmOpen(false);
      onRemoved(account.id);
    } catch (e) {
      setError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-foreground">@{account.username}</span>
          <span className="text-xs text-muted-foreground">
            {INSTAGRAM_PROVIDER_LABEL[account.provider]} · ID de cuenta: {account.igAccountId}
            {account.pageId ? ` · Página: ${account.pageId}` : ''}
          </span>
          <span className="text-xs text-muted-foreground">Conectada el {formatDateCO(account.createdAt)}</span>
        </div>
        <Badge variant={STATUS_VARIANT[account.status] ?? 'secondary'}>{instagramStatusLabel(account.status)}</Badge>
      </div>

      {/* Siempre visible y no detrás de un "ver detalles": un comerciante al
          que "Instagram no le funciona" es casi siempre un comerciante con la
          URL de callback mal puesta, y este es el valor que necesita comparar
          con lo que pegó en Meta. */}
      <CallbackPanel
        provider={account.provider}
        igAccountId={account.igAccountId}
        callbackBaseUrl={callbackBaseUrl}
      />

      {error ? <Alert variant="error">{error}</Alert> : null}

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" disabled={submitting} onClick={() => void handleToggle()}>
          {disabled ? 'Activar' : 'Desactivar'}
        </Button>
        <Button variant="destructive" size="sm" disabled={submitting} onClick={() => setConfirmOpen(true)}>
          Desconectar
        </Button>
      </div>

      {/* Con confirmación y no al primer clic: desconectar borra la fila que
          enruta los mensajes entrantes, así que la tienda deja de recibir
          Instagram en ese momento — y volver a conectarla significa buscar otra
          vez las credenciales en Meta. "Desactivar" es la acción reversible y
          está un botón a la izquierda. */}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-foreground">Desconectar @{account.username}</h2>
          <p className="text-sm text-foreground">
            Tu tienda dejará de recibir y responder mensajes directos en esta cuenta. Para volver a usarla tendrás que
            conectarla de nuevo con sus credenciales. Si solo quieres pausarla, usa “Desactivar”.
          </p>
          {error ? <Alert variant="error">{error}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
              Cancelar
            </Button>
            <Button variant="destructive" disabled={submitting} onClick={() => void handleDisconnect()}>
              {submitting ? 'Desconectando…' : 'Desconectar'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* La URL de callback                                                         */
/* -------------------------------------------------------------------------- */

/** La URL que el comerciante pega en Meta, con el `?account=` que necesita el
 * saludo, más un botón de copiar. La construye `instagramCallbackUrl`
 * (lib/instagram-api.ts), que es donde está el razonamiento sobre ese
 * parámetro. */
function CallbackPanel({
  provider,
  igAccountId,
  callbackBaseUrl,
}: {
  provider: InstagramProviderId;
  igAccountId: string;
  callbackBaseUrl: string;
}) {
  const url = instagramCallbackUrl(callbackBaseUrl, provider, igAccountId);
  if (!url) return null;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3">
      <span className="text-xs font-medium text-foreground">URL de callback para Meta</span>
      <CopyableValue value={url} label="URL de callback" />
      <p className="text-xs text-muted-foreground">
        Cópiala completa, incluyendo la parte <code className="font-mono">?account={igAccountId}</code>. Meta no nos
        dice qué cuenta está verificando, así que sin esa parte la verificación falla siempre. En el panel de Meta va
        en Webhooks, suscrita al campo <code className="font-mono">messages</code> de Instagram.
      </p>
    </div>
  );
}

/** Un valor pensado para copiarse, con botón y con el texto siempre visible y
 * seleccionable — la API del portapapeles no existe sobre http plano en un
 * origen que no sea localhost, y un botón de copiar que no hace nada en
 * silencio es peor que ninguno, así que el fallo se dice y el texto se queda
 * seleccionable. */
function CopyableValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground">
          {value}
        </code>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-label={`Copiar ${label}`}
          onClick={() => void handleCopy()}
        >
          {copied ? 'Copiada' : 'Copiar'}
        </Button>
      </div>
      {copyFailed ? (
        <span className="text-xs text-destructive">No pudimos copiarla. Selecciónala y cópiala manualmente.</span>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Formulario de conexión                                                     */
/* -------------------------------------------------------------------------- */

function ConnectSection({
  callbackBaseUrl,
  onConnected,
}: {
  callbackBaseUrl: string;
  onConnected: (account: InstagramAccount) => void;
}) {
  const [fields, setFields] = useState<InstagramFormFields>(BLANK_INSTAGRAM_FORM);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [connected, setConnected] = useState<InstagramAccount | null>(null);

  function update(patch: Partial<InstagramFormFields>) {
    setFields((prev) => ({ ...prev, ...patch }));
    setConnected(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setErrors({});
    setConnected(null);
    setSubmitting(true);
    try {
      const account = await connectInstagramAccount(buildInstagramConnectPayload(fields));
      onConnected(account);
      setConnected(account);
      // Las credenciales recién enviadas no tienen por qué seguir en el
      // formulario: ya están guardadas (cifradas) en el servidor y la cuenta
      // está arriba en la lista. Misma postura que PagosTab tras un guardado.
      setFields(BLANK_INSTAGRAM_FORM);
    } catch (e) {
      if (e instanceof ApiError) {
        // Las claves de `fieldErrors` son nombres de campo reales
        // (`igAccountId`, `username`, …) y caen en el input correcto.
        if (e.code === 'VALIDATION_FAILED') setErrors(fieldErrors(e));
        else setError(errorMessage(e));
      } else {
        setError('Ocurrió un error inesperado. Intenta de nuevo.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
      <h3 className="text-sm font-medium text-foreground">Conectar una cuenta</h3>
      <p className="-mt-2 text-xs text-muted-foreground">
        Necesitas una cuenta profesional de Instagram vinculada a una página de Facebook, y la app de Meta desde la
        que sacas el token. Los cuatro datos de abajo están en el panel de Meta for Developers.
      </p>

      {error ? <Alert variant="error">{error}</Alert> : null}
      {connected ? (
        <Alert variant="success">
          Conectamos @{connected.username}. Falta un paso: pega la URL de callback y tu token de verificación en Meta
          para terminar la verificación.
        </Alert>
      ) : null}
      {connected ? (
        <CallbackPanel
          provider={connected.provider}
          igAccountId={connected.igAccountId}
          callbackBaseUrl={callbackBaseUrl}
        />
      ) : null}

      <FormField label="Usuario de Instagram" htmlFor="instagram-username" error={errors.username}>
        <Input
          id="instagram-username"
          value={fields.username}
          onChange={(event) => update({ username: event.target.value })}
          placeholder="@mitienda"
          maxLength={120}
          required
        />
      </FormField>
      <p className="-mt-3 text-xs text-muted-foreground">
        Solo para que reconozcas la cuenta en esta lista. Puedes escribirlo con arroba o sin ella.
      </p>

      <FormField label="ID de la cuenta de Instagram" htmlFor="instagram-account-id" error={errors.igAccountId}>
        <Input
          id="instagram-account-id"
          value={fields.igAccountId}
          onChange={(event) => update({ igAccountId: event.target.value })}
          placeholder="17841405793187218"
          inputMode="numeric"
          maxLength={32}
          required
        />
      </FormField>
      <p className="-mt-3 text-xs text-muted-foreground">
        Solo números. Es el ID de tu cuenta profesional, no el usuario. Con este dato sabemos que un mensaje que llega
        es tuyo, así que si te equivocas, no recibirás nada.
      </p>

      <FormField label="ID de la página de Facebook" htmlFor="instagram-page-id" error={errors.pageId}>
        <Input
          id="instagram-page-id"
          value={fields.pageId}
          onChange={(event) => update({ pageId: event.target.value })}
          placeholder="102290129340398"
          inputMode="numeric"
          maxLength={32}
          required
        />
      </FormField>
      <p className="-mt-3 text-xs text-muted-foreground">
        La página a la que está vinculada tu cuenta de Instagram. Está en Configuración de la página → Información.
      </p>

      <FormField label="Token de acceso de la página" htmlFor="instagram-access-token" error={errors.accessToken}>
        <Input
          id="instagram-access-token"
          type="password"
          value={fields.accessToken}
          onChange={(event) => update({ accessToken: event.target.value })}
          placeholder="Pega aquí el token de Meta"
          maxLength={512}
          required
        />
      </FormField>

      <FormField label="Clave secreta de la app (App Secret)" htmlFor="instagram-app-secret" error={errors.appSecret}>
        <Input
          id="instagram-app-secret"
          type="password"
          value={fields.appSecret}
          onChange={(event) => update({ appSecret: event.target.value })}
          placeholder="Pega aquí el App Secret de Meta"
          maxLength={128}
          required
        />
      </FormField>
      <p className="-mt-3 text-xs text-muted-foreground">
        Con esta clave verificamos que cada mensaje entrante venga de verdad de Meta. La encuentras en Configuración
        de la app → Básica.
      </p>

      {/* A propósito NO es un campo de contraseña: este lo elige el
          comerciante ahora mismo y tiene que transcribirlo, carácter por
          carácter, al panel de Meta en la misma sentada. Esconderlo aquí solo
          conseguiría que lo escribiera mal — y no vuelve nunca del servidor,
          así que este es el único momento en que puede verlo. */}
      <FormField label="Token de verificación" htmlFor="instagram-verify-token" error={errors.verifyToken}>
        <Input
          id="instagram-verify-token"
          value={fields.verifyToken}
          onChange={(event) => update({ verifyToken: event.target.value })}
          placeholder="Inventa una clave de al menos 8 caracteres"
          maxLength={128}
          required
        />
      </FormField>
      <p className="-mt-3 text-xs text-muted-foreground">
        Lo eliges tú y debe quedar idéntico acá y en Meta. Guárdalo en un lugar seguro: por seguridad no volvemos a
        mostrarlo, y si lo pierdes tendrás que conectar la cuenta otra vez con uno nuevo.
      </p>

      <Button type="submit" className="self-start" disabled={submitting}>
        {submitting ? 'Conectando…' : 'Conectar cuenta'}
      </Button>

      {/* La ventana de 24 horas es una regla de Meta, no nuestra, y es la única
          diferencia visible frente a WhatsApp: si un cliente escribió hace más
          de un día, el asistente no puede contestarle hasta que vuelva a
          escribir. Decirlo aquí evita el ticket de "no respondió a este
          mensaje". */}
      <Alert variant="info">
        Instagram solo permite responder dentro de las 24 horas siguientes al mensaje de tu cliente. Pasado ese plazo,
        el asistente no contesta hasta que la persona vuelva a escribir: es una regla de Meta y saltársela puede costar
        el canal.
      </Alert>
    </form>
  );
}
