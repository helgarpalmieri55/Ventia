'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Dialog, FormField, Input, Select, Spinner, type BadgeVariant } from '@ventia/ui';
import { ApiError } from '../lib/api';
import { errorMessage, fieldErrors } from '../lib/errors';
import { formatDateCO } from '../lib/format';
import {
  BLANK_WHATSAPP_FORM,
  WHATSAPP_EXTERNAL_ID_LABEL,
  WHATSAPP_PROVIDER_LABEL,
  buildWhatsAppConnectPayload,
  connectWhatsAppNumber,
  disconnectWhatsAppNumber,
  listWhatsAppNumbers,
  setWhatsAppNumberStatus,
  whatsappCallbackUrl,
  whatsappStatusLabel,
  type WhatsAppFormFields,
  type WhatsAppNumber,
  type WhatsAppNumbersResponse,
  type WhatsAppProviderId,
} from '../lib/whatsapp-api';

/**
 * WhatsApp tab: connect the store's WhatsApp line, and manage the ones already
 * connected (docs/SPEC.md §11 P5).
 *
 * Takes no props, unlike its sibling tabs: none of this lives in
 * `GET /v1/admin/settings` — it is its own owner-only resource with its own
 * plan gate — so threading `settings`/`onSaved` through would only hand this
 * component state it must not write.
 *
 * The list is rendered even when the plan does not include the channel. A
 * downgraded store still has live numbers it may want to see and disconnect;
 * what disappears with the plan is the *form*, because `POST` would 402.
 */
export function WhatsAppTab() {
  const [data, setData] = useState<WhatsAppNumbersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setData(await listWhatsAppNumbers());
    } catch (e) {
      setLoadError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Merges the row a POST/PATCH returned into the list BY ID rather than
   * appending: re-connecting a number this store already owns updates the
   * existing row server-side and returns that same id, so appending would show
   * the merchant two rows for one line. */
  const upsertNumber = useCallback((number: WhatsAppNumber) => {
    setData((prev) => {
      if (!prev) return prev;
      const exists = prev.items.some((item) => item.id === number.id);
      return {
        ...prev,
        items: exists ? prev.items.map((item) => (item.id === number.id ? number : item)) : [...prev.items, number],
      };
    });
  }, []);

  const removeNumber = useCallback((id: string) => {
    setData((prev) => (prev ? { ...prev, items: prev.items.filter((item) => item.id !== id) } : prev));
  }, []);

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Cargando tus números de WhatsApp…
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
      <NumbersList
        items={data.items}
        callbackBaseUrl={data.callbackBaseUrl}
        channelEnabled={data.channelEnabled}
        onUpdated={upsertNumber}
        onRemoved={removeNumber}
      />

      <div className="border-t border-border pt-6">
        {data.channelEnabled ? (
          <ConnectSection callbackBaseUrl={data.callbackBaseUrl} onConnected={upsertNumber} />
        ) : (
          <UpgradePrompt hasNumbers={data.items.length > 0} />
        )}
      </div>
    </div>
  );
}

/** Shown INSTEAD of the connect form when `TenantLimits.whatsappChannel` is
 * false. A form that can only ever answer 402 is worse than no form: it costs
 * the merchant a round of typing their Meta credentials to learn something we
 * already knew before the page rendered. */
function UpgradePrompt({ hasNumbers }: { hasNumbers: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">Conectar un número</h3>
      <Alert variant="warning">
        <p>
          Tu plan actual no incluye el canal de WhatsApp, así que todavía no puedes conectar un número. Mejora tu plan
          para atender a tus clientes por WhatsApp desde acá.
        </p>
        {hasNumbers ? (
          <p className="mt-2">
            Los números que ya tienes conectados siguen en la lista, pero no reciben mensajes mientras tu plan no
            incluya el canal.
          </p>
        ) : null}
      </Alert>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Connected numbers                                                          */
/* -------------------------------------------------------------------------- */

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  connected: 'default',
  disabled: 'destructive',
  pending: 'secondary',
};

function NumbersList({
  items,
  callbackBaseUrl,
  channelEnabled,
  onUpdated,
  onRemoved,
}: {
  items: WhatsAppNumber[];
  callbackBaseUrl: string;
  channelEnabled: boolean;
  onUpdated: (number: WhatsAppNumber) => void;
  onRemoved: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-sm font-medium text-foreground">Tus números conectados</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {channelEnabled
            ? 'Todavía no has conectado ningún número. Conéctalo abajo para que tus clientes te escriban por WhatsApp.'
            : 'Todavía no has conectado ningún número.'}
        </p>
      ) : (
        items.map((number) => (
          <NumberRow
            key={number.id}
            number={number}
            callbackBaseUrl={callbackBaseUrl}
            onUpdated={onUpdated}
            onRemoved={onRemoved}
          />
        ))
      )}
    </div>
  );
}

function NumberRow({
  number,
  callbackBaseUrl,
  onUpdated,
  onRemoved,
}: {
  number: WhatsAppNumber;
  callbackBaseUrl: string;
  onUpdated: (number: WhatsAppNumber) => void;
  onRemoved: (id: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const disabled = number.status === 'disabled';

  async function handleToggle() {
    setError(null);
    setSubmitting(true);
    try {
      onUpdated(await setWhatsAppNumberStatus(number.id, disabled ? 'connected' : 'disabled'));
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
      await disconnectWhatsAppNumber(number.id);
      setConfirmOpen(false);
      onRemoved(number.id);
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
          <span className="text-sm font-medium text-foreground">{number.displayPhone}</span>
          <span className="text-xs text-muted-foreground">
            {WHATSAPP_PROVIDER_LABEL[number.provider]} · {WHATSAPP_EXTERNAL_ID_LABEL[number.provider]}:{' '}
            {number.externalId}
          </span>
          <span className="text-xs text-muted-foreground">Conectado el {formatDateCO(number.createdAt)}</span>
        </div>
        <Badge variant={STATUS_VARIANT[number.status] ?? 'secondary'}>{whatsappStatusLabel(number.status)}</Badge>
      </div>

      {/* Kept visible on every row, not behind a "ver detalles": a merchant
          whose WhatsApp "doesn't work" is nearly always a merchant whose
          callback URL is wrong, and this is the value they need to compare
          against what they pasted into Meta. */}
      <CallbackPanel provider={number.provider} externalId={number.externalId} callbackBaseUrl={callbackBaseUrl} />

      {error ? <Alert variant="error">{error}</Alert> : null}

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" disabled={submitting} onClick={() => void handleToggle()}>
          {disabled ? 'Activar' : 'Desactivar'}
        </Button>
        <Button variant="destructive" size="sm" disabled={submitting} onClick={() => setConfirmOpen(true)}>
          Desconectar
        </Button>
      </div>

      {/* Confirmed rather than fired on click: disconnecting deletes the row
          that routes inbound messages, so the store stops receiving WhatsApp
          the moment it happens — and reconnecting means finding the Meta
          credentials again. "Desactivar" is the reversible action and is one
          button to the left. */}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-foreground">Desconectar {number.displayPhone}</h2>
          <p className="text-sm text-foreground">
            Tu tienda dejará de recibir y responder mensajes en este número. Para volver a usarlo tendrás que
            conectarlo de nuevo con sus credenciales. Si solo quieres pausarlo, usa “Desactivar”.
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
/* The callback URL                                                           */
/* -------------------------------------------------------------------------- */

/** The URL the merchant pastes into their provider, with the `?number=` param
 * Meta's handshake needs, plus a copy button. Built by `whatsappCallbackUrl`
 * (lib/whatsapp-api.ts), which is where the reasoning about that param lives. */
function CallbackPanel({
  provider,
  externalId,
  callbackBaseUrl,
}: {
  provider: WhatsAppProviderId;
  externalId: string;
  callbackBaseUrl: string;
}) {
  const url = whatsappCallbackUrl(callbackBaseUrl, provider, externalId);
  if (!url) return null;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3">
      <span className="text-xs font-medium text-foreground">
        {provider === 'cloud' ? 'URL de callback para Meta' : 'URL del webhook para tu instancia de Evolution'}
      </span>
      <CopyableValue value={url} label="URL de callback" />
      {provider === 'cloud' ? (
        <p className="text-xs text-muted-foreground">
          Cópiala completa, incluyendo la parte <code className="font-mono">?number={externalId}</code>. Meta no nos
          dice qué número está verificando, así que sin esa parte la verificación falla siempre.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Configúrala como webhook de la instancia <code className="font-mono">{externalId}</code>. Evolution ya envía
          el nombre de la instancia en cada mensaje, por eso esta URL no lleva parámetros.
        </p>
      )}
    </div>
  );
}

/** A value shown to be copied, with a button and the raw text always visible
 * and selectable — the clipboard API is unavailable over plain http on a
 * non-localhost origin, and a copy button that silently does nothing is worse
 * than none, so the failure says so and the text stays selectable. */
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
/* Connect form                                                               */
/* -------------------------------------------------------------------------- */

function ConnectSection({
  callbackBaseUrl,
  onConnected,
}: {
  callbackBaseUrl: string;
  onConnected: (number: WhatsAppNumber) => void;
}) {
  const [fields, setFields] = useState<WhatsAppFormFields>(BLANK_WHATSAPP_FORM);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [connected, setConnected] = useState<WhatsAppNumber | null>(null);

  function update(patch: Partial<WhatsAppFormFields>) {
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
      const number = await connectWhatsAppNumber(buildWhatsAppConnectPayload(fields));
      onConnected(number);
      setConnected(number);
      // The credentials just sent have no reason to keep sitting in the form:
      // they are already stored (encrypted) server-side, and the number is now
      // in the list above. Same posture as PagosTab after a successful save.
      setFields({ ...BLANK_WHATSAPP_FORM, provider: fields.provider });
    } catch (e) {
      if (e instanceof ApiError) {
        // `whatsappConnectSchema` is a discriminated union, and the picker can
        // only ever produce a valid `provider`, so a VALIDATION_FAILED here
        // always comes from the matched branch — its `fieldErrors` keys are
        // real field names (`phoneNumberId`, `displayPhone`, …) and land on
        // the right input.
        if (e.code === 'VALIDATION_FAILED') setErrors(fieldErrors(e));
        else setError(errorMessage(e));
      } else {
        setError('Ocurrió un error inesperado. Intenta de nuevo.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const isCloud = fields.provider === 'cloud';

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
      <h3 className="text-sm font-medium text-foreground">Conectar un número</h3>

      {error ? <Alert variant="error">{error}</Alert> : null}
      {connected ? (
        <Alert variant="success">
          Conectamos {connected.displayPhone}.{' '}
          {connected.provider === 'cloud'
            ? 'Falta un paso: pega la URL de callback y tu token de verificación en Meta para terminar la verificación.'
            : 'Falta un paso: configura la URL del webhook en tu instancia de Evolution.'}
        </Alert>
      ) : null}
      {connected ? (
        <CallbackPanel
          provider={connected.provider}
          externalId={connected.externalId}
          callbackBaseUrl={callbackBaseUrl}
        />
      ) : null}

      <FormField label="Proveedor" htmlFor="whatsapp-provider" error={errors.provider}>
        <Select
          id="whatsapp-provider"
          value={fields.provider}
          onChange={(event) => update({ provider: event.target.value as WhatsAppProviderId })}
        >
          <option value="cloud">{WHATSAPP_PROVIDER_LABEL.cloud}</option>
          <option value="evolution">{WHATSAPP_PROVIDER_LABEL.evolution}</option>
        </Select>
      </FormField>
      <p className="-mt-3 text-xs text-muted-foreground">
        Cloud API es la conexión oficial de Meta y es la que usa la mayoría de tiendas. Evolution es para cuando tienes
        tu propio servidor de WhatsApp.
      </p>

      <FormField label="Número de WhatsApp" htmlFor="whatsapp-display-phone" error={errors.displayPhone}>
        <Input
          id="whatsapp-display-phone"
          type="tel"
          value={fields.displayPhone}
          onChange={(event) => update({ displayPhone: event.target.value })}
          placeholder="300 123 4567"
          maxLength={24}
          required
        />
      </FormField>
      <p className="-mt-3 text-xs text-muted-foreground">
        El celular colombiano de tu línea de WhatsApp. Puedes escribirlo como quieras (300 123 4567, +57 300 123
        4567); nosotros lo guardamos en un solo formato.
      </p>

      {isCloud ? <CloudFields fields={fields} errors={errors} update={update} /> : null}
      {!isCloud ? <EvolutionFields fields={fields} errors={errors} update={update} /> : null}

      <Button type="submit" className="self-start" disabled={submitting}>
        {submitting ? 'Conectando…' : 'Conectar número'}
      </Button>
    </form>
  );
}

interface FieldGroupProps {
  fields: WhatsAppFormFields;
  errors: Record<string, string>;
  update: (patch: Partial<WhatsAppFormFields>) => void;
}

function CloudFields({ fields, errors, update }: FieldGroupProps) {
  return (
    <>
      <FormField label="Phone number ID de Meta" htmlFor="whatsapp-phone-number-id" error={errors.phoneNumberId}>
        <Input
          id="whatsapp-phone-number-id"
          value={fields.phoneNumberId}
          onChange={(event) => update({ phoneNumberId: event.target.value })}
          placeholder="123456789012345"
          inputMode="numeric"
          maxLength={32}
          required
        />
      </FormField>
      <p className="-mt-3 text-xs text-muted-foreground">
        Solo números. Está en Meta for Developers, en WhatsApp → Configuración de la API, debajo de tu número. No es
        el número de teléfono.
      </p>

      <FormField label="Token de acceso permanente" htmlFor="whatsapp-access-token" error={errors.accessToken}>
        <Input
          id="whatsapp-access-token"
          type="password"
          value={fields.accessToken}
          onChange={(event) => update({ accessToken: event.target.value })}
          placeholder="Pega aquí el token de Meta"
          maxLength={512}
          required
        />
      </FormField>

      <FormField label="Clave secreta de la app (App Secret)" htmlFor="whatsapp-app-secret" error={errors.appSecret}>
        <Input
          id="whatsapp-app-secret"
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

      {/* Deliberately NOT a password input: this one is chosen by the merchant
          right now and has to be transcribed, character for character, into
          Meta's dashboard in the same sitting. Hiding it here would only make
          them mistype it — and it never comes back from the server, so this is
          the only moment they can see it. */}
      <FormField label="Token de verificación" htmlFor="whatsapp-verify-token" error={errors.verifyToken}>
        <Input
          id="whatsapp-verify-token"
          value={fields.verifyToken}
          onChange={(event) => update({ verifyToken: event.target.value })}
          placeholder="Inventa una clave de al menos 8 caracteres"
          maxLength={128}
          required
        />
      </FormField>
      <p className="-mt-3 text-xs text-muted-foreground">
        Lo eliges tú y debe quedar idéntico acá y en Meta. Guárdalo en un lugar seguro: por seguridad no volvemos a
        mostrarlo, y si lo pierdes tendrás que conectar el número otra vez con uno nuevo.
      </p>
    </>
  );
}

function EvolutionFields({ fields, errors, update }: FieldGroupProps) {
  return (
    <>
      <FormField label="Nombre de la instancia" htmlFor="whatsapp-instance-name" error={errors.instanceName}>
        <Input
          id="whatsapp-instance-name"
          value={fields.instanceName}
          onChange={(event) => update({ instanceName: event.target.value })}
          placeholder="mi-tienda"
          maxLength={64}
          required
        />
      </FormField>
      <p className="-mt-3 text-xs text-muted-foreground">
        Tal como la creaste en tu servidor Evolution. Solo letras, números, puntos, guiones y guiones bajos.
      </p>

      <FormField label="API key de la instancia" htmlFor="whatsapp-api-key" error={errors.apiKey}>
        <Input
          id="whatsapp-api-key"
          type="password"
          value={fields.apiKey}
          onChange={(event) => update({ apiKey: event.target.value })}
          placeholder="Pega aquí la apikey de tu instancia"
          maxLength={256}
          required
        />
      </FormField>

      <FormField label="URL de tu servidor Evolution" htmlFor="whatsapp-base-url" error={errors.baseUrl}>
        <Input
          id="whatsapp-base-url"
          type="url"
          value={fields.baseUrl}
          onChange={(event) => update({ baseUrl: event.target.value })}
          placeholder="https://evolution.tudominio.com"
          maxLength={200}
          required
        />
      </FormField>
    </>
  );
}
