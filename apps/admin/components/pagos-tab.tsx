'use client';

import { useState, type FormEvent } from 'react';
import { Alert, Button, FormField, Input, Label } from '@ventia/ui';
import { ApiError, apiFetch } from '../lib/api';
import { errorMessage, fieldErrors } from '../lib/errors';
import { BLANK_WOMPI_FORM, buildWompiCredentialsPayload, type WompiFormFields } from '../lib/wompi-form';
import {
  BLANK_MERCADOPAGO_FORM,
  buildMercadoPagoCredentialsPayload,
  type MercadoPagoFormFields,
} from '../lib/mercadopago-form';
import { BLANK_EPAYCO_FORM, buildEpaycoCredentialsPayload, type EpaycoFormFields } from '../lib/epayco-form';
import type { SettingsResponse, TabProps } from '../app/(app)/configuracion/page';

/** Pagos tab: two independent sub-forms, each with its own save button and
 * its own `submitting`/`error`/`saved` state, rather than one combined
 * submit. `codEnabled` (`PATCH /v1/admin/settings/payments` with just
 * `{codEnabled}`) and Wompi credentials (same endpoint, with just
 * `{providers: {wompi: {...}}}`) are merged INDEPENDENTLY server-side
 * (settings.controller.ts's `updatePayments` — a design doc decision), so
 * there is no requirement to send them together, and combining them into one
 * submit would force every COD-only toggle to also resend a full,
 * currently-blank Wompi credential set (or vice versa) for no reason. This
 * mirrors EnviosTab's extraction rationale (shipping-tab.tsx) — Wompi adds
 * enough fields + a test-connection flow that this tab earned its own file
 * once combined with the pre-existing COD toggle. */
export function PagosTab({ settings, onSaved }: TabProps) {
  return (
    <div className="flex flex-col gap-8">
      <CodSection settings={settings} onSaved={onSaved} />
      <div className="border-t border-border pt-6">
        <WompiSection settings={settings} onSaved={onSaved} />
      </div>
      <div className="border-t border-border pt-6">
        <MercadoPagoSection settings={settings} onSaved={onSaved} />
      </div>
      <div className="border-t border-border pt-6">
        <EpaycoSection settings={settings} onSaved={onSaved} />
      </div>
    </div>
  );
}

function CodSection({ settings, onSaved }: TabProps) {
  const [codEnabled, setCodEnabled] = useState(settings.payments.codEnabled);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    setError(null);
    setSaved(false);
    setSubmitting(true);
    try {
      const updated = await apiFetch<SettingsResponse>('/v1/admin/settings/payments', {
        method: 'PATCH',
        body: JSON.stringify({ codEnabled }),
      });
      onSaved(updated);
      setSaved(true);
    } catch (e) {
      setError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-sm font-medium text-foreground">Pago contra-entrega</h3>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {saved ? <Alert variant="success">Los cambios se guardaron correctamente.</Alert> : null}
      <div className="flex items-center gap-3 rounded-md border border-border p-3">
        <input
          id="pagos-cod-enabled"
          type="checkbox"
          className="h-4 w-4"
          checked={codEnabled}
          onChange={(event) => {
            setCodEnabled(event.target.checked);
            setSaved(false);
          }}
        />
        <Label htmlFor="pagos-cod-enabled">Aceptar pago contraentrega</Label>
      </div>
      <Button onClick={() => void handleSave()} disabled={submitting} className="self-start">
        {submitting ? 'Guardando…' : 'Guardar'}
      </Button>
    </div>
  );
}

/** Wompi sub-form: `PATCH /v1/admin/settings/payments` with just
 * `{providers: {wompi: {...}}}`, plus a read-only "what's currently saved"
 * summary and a "Probar conexión" action.
 *
 * Every credential field (`publicKey`/`privateKey`/`integritySecret`/
 * `eventsSecret`) starts BLANK on every mount — `GET /v1/admin/settings`
 * never returns a plaintext secret to prefill from (see
 * `settings.controller.ts`'s `maskedWompiView`), and `saveProviderCredentials`
 * overwrites the WHOLE stored credential record on every save (not a
 * per-field merge), so re-saving — even just to flip the sandbox toggle —
 * requires re-typing `publicKey`/`privateKey`/`sandbox` every time. That
 * constraint is called out explicitly in this form's copy so it doesn't read
 * as a bug. */
function WompiSection({ settings, onSaved }: TabProps) {
  const wompi = settings.payments.providers.wompi;

  const [fields, setFields] = useState<WompiFormFields>(BLANK_WOMPI_FORM);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);

  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);

  function update(patch: Partial<WompiFormFields>) {
    setFields((prev) => ({ ...prev, ...patch }));
    setSaved(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setErrors({});
    setEnvironmentError(null);
    setSaved(false);
    setTestResult(null);

    const payload = buildWompiCredentialsPayload(fields);
    if (!payload) {
      setEnvironmentError('Elige si esta conexión es de pruebas (sandbox) o de producción.');
      return;
    }

    setSubmitting(true);
    try {
      const updated = await apiFetch<SettingsResponse>('/v1/admin/settings/payments', {
        method: 'PATCH',
        body: JSON.stringify({ providers: { wompi: payload } }),
      });
      onSaved(updated);
      setSaved(true);
      // The secrets just sent must not keep sitting in the form after a
      // successful save — they're already persisted (encrypted) server-side,
      // and there's no reason for their plaintext to linger in memory/DOM any
      // longer than the request itself needed it. publicKey is left as typed
      // (it isn't secret, and re-showing it lets the merchant confirm what
      // they just saved without re-typing it on the next unrelated edit).
      setFields((prev) => ({ ...prev, privateKey: '', integritySecret: '', eventsSecret: '' }));
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'VALIDATION_FAILED') setErrors(fieldErrors(e));
        else setError(errorMessage(e));
      } else {
        setError('Ocurrió un error inesperado. Intenta de nuevo.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTestConnection() {
    setTestResult(null);
    setTesting(true);
    try {
      const result = await apiFetch<{ ok: boolean; error?: string }>(
        '/v1/admin/settings/payments/wompi/test-connection',
        { method: 'POST' },
      );
      setTestResult(result);
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof ApiError ? errorMessage(e) : 'No pudimos probar la conexión.' });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-sm font-medium text-foreground">Wompi</h3>

      <div className="flex flex-col gap-1 rounded-md border border-border p-3 text-sm">
        <span>
          Estado: <strong>{wompi.connected ? 'Conectado' : 'No conectado'}</strong>
        </span>
        {wompi.connected ? (
          <>
            <span className="text-muted-foreground">Llave pública guardada: {wompi.publicKeyMasked}</span>
            <span className="text-muted-foreground">Entorno: {wompi.sandbox ? 'Sandbox (pruebas)' : 'Producción'}</span>
          </>
        ) : (
          <span className="text-muted-foreground">Aún no has guardado credenciales de Wompi.</span>
        )}
      </div>

      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        {error ? <Alert variant="error">{error}</Alert> : null}
        {/* zod's `.flatten()` keys a nested-object field by its first path
            segment only (same limitation TiendaTab/MarcaTab already document
            for their own nested `storeInfo`/`colors` fields) — a validation
            failure anywhere under `providers.wompi.*` surfaces as one
            `providers` key, never `publicKey`/`privateKey` individually, so
            this is a single alert above the credential fields rather than
            per-FormField `error` props (which would always be undefined for
            this shape). */}
        {errors.providers ? <Alert variant="error">{errors.providers}</Alert> : null}
        {saved ? <Alert variant="success">Los cambios se guardaron correctamente.</Alert> : null}

        <p className="text-sm text-muted-foreground">
          Debes volver a ingresar todas tus credenciales de Wompi cada vez que actualices esta configuración —
          Wompi se guarda como un solo bloque, así que un cambio parcial (por ejemplo, solo el entorno) también
          requiere reescribir la llave pública, la llave privada y elegir el entorno de nuevo.
        </p>

        <FormField label="Llave pública" htmlFor="wompi-public-key">
          <Input
            value={fields.publicKey}
            onChange={(event) => update({ publicKey: event.target.value })}
            placeholder="pub_prod_… o pub_test_…"
            required
          />
        </FormField>

        <FormField label="Llave privada" htmlFor="wompi-private-key">
          <Input
            type="password"
            value={fields.privateKey}
            onChange={(event) => update({ privateKey: event.target.value })}
            placeholder="Vuelve a escribir tu llave privada"
            required
          />
        </FormField>

        <FormField label="Secreto de integridad (para firmar el checkout)" htmlFor="wompi-integrity-secret">
          <Input
            type="password"
            value={fields.integritySecret}
            onChange={(event) => update({ integritySecret: event.target.value })}
            placeholder="Necesario para poder cobrar — sin este secreto Wompi no puede crear el checkout"
          />
        </FormField>
        <p className="-mt-2 text-xs text-muted-foreground">
          El formulario lo acepta vacío, pero sin este secreto Wompi no puede generar el link de pago: es requerido
          en la práctica para que el checkout funcione, aunque el campo en sí sea técnicamente opcional.
        </p>

        <FormField label="Secreto de eventos (para verificar webhooks)" htmlFor="wompi-events-secret">
          <Input
            type="password"
            value={fields.eventsSecret}
            onChange={(event) => update({ eventsSecret: event.target.value })}
            placeholder="Necesario para confirmar pagos automáticamente vía webhook"
          />
        </FormField>
        <p className="-mt-2 text-xs text-muted-foreground">
          También técnicamente opcional, pero sin este secreto los webhooks de Wompi (confirmaciones y rechazos de
          pago) no se pueden verificar y la tienda nunca marcará un pedido como pagado automáticamente.
        </p>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-foreground">Entorno</span>
          {environmentError ? <Alert variant="error">{environmentError}</Alert> : null}
          <div className="flex gap-4">
            <div className="flex items-center gap-2">
              <input
                id="wompi-env-sandbox"
                type="radio"
                name="wompi-environment"
                className="h-4 w-4"
                checked={fields.sandbox === true}
                onChange={() => update({ sandbox: true })}
              />
              <Label htmlFor="wompi-env-sandbox">Sandbox (pruebas)</Label>
            </div>
            <div className="flex items-center gap-2">
              <input
                id="wompi-env-production"
                type="radio"
                name="wompi-environment"
                className="h-4 w-4"
                checked={fields.sandbox === false}
                onChange={() => update({ sandbox: false })}
              />
              <Label htmlFor="wompi-env-production">Producción</Label>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            No hay un entorno seleccionado por defecto: debes elegir uno explícitamente cada vez, para evitar
            dejar accidentalmente una tienda en modo de pruebas (o viceversa).
          </p>
        </div>

        <Button type="submit" disabled={submitting} className="self-start">
          {submitting ? 'Guardando…' : 'Guardar'}
        </Button>
      </form>

      <div className="flex flex-col gap-2 rounded-md border border-border p-3">
        <p className="text-sm text-muted-foreground">
          "Probar conexión" prueba las credenciales que ya están <strong>guardadas</strong> en el servidor, no lo
          que hayas escrito en este formulario sin guardar todavía. Si acabas de cambiar tus credenciales, guarda
          primero y luego prueba la conexión.
        </p>
        {testResult ? (
          <Alert variant={testResult.ok ? 'success' : 'error'}>
            {testResult.ok ? 'Conexión exitosa.' : (testResult.error ?? 'La conexión falló.')}
          </Alert>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="self-start"
          disabled={!wompi.connected || testing}
          onClick={() => void handleTestConnection()}
        >
          {testing ? 'Probando…' : 'Probar conexión'}
        </Button>
        {!wompi.connected ? (
          <p className="text-xs text-muted-foreground">Guarda tus credenciales de Wompi antes de probar la conexión.</p>
        ) : null}
      </div>
    </div>
  );
}

/** Mercado Pago sub-form: same shape/posture as `WompiSection` (see its doc
 * comment for the shared reasoning — blank-on-every-mount secret fields, an
 * explicit no-default sandbox/production choice, `PATCH
 * /v1/admin/settings/payments` merges `providers.mercadopago` independently
 * of the other providers, "Probar conexión" tests whatever is already
 * SAVED, not this form's unsaved input). The one real difference: Mercado
 * Pago has a single optional secret (`eventsSecret`), not Wompi's two —
 * `mercadopagoCredentialsSchema` has no `integritySecret` counterpart because
 * Mercado Pago's checkout flow needs no separate checkout-signing secret
 * (see `packages/payments/src/mercadopago.ts`'s own doc comments). That one
 * secret exists purely to verify the `x-signature` HMAC on incoming webhooks
 * (`MercadoPagoProvider.verifyAndParseWebhook` throws without it) — it is
 * NOT read by `createCheckoutSession`, so, same as Wompi's `eventsSecret`,
 * the copy below frames it as "technically optional, practically required
 * for automatic payment confirmation to work," not as a checkout-blocking
 * requirement. */
function MercadoPagoSection({ settings, onSaved }: TabProps) {
  const mercadopago = settings.payments.providers.mercadopago;

  const [fields, setFields] = useState<MercadoPagoFormFields>(BLANK_MERCADOPAGO_FORM);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);

  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);

  function update(patch: Partial<MercadoPagoFormFields>) {
    setFields((prev) => ({ ...prev, ...patch }));
    setSaved(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setErrors({});
    setEnvironmentError(null);
    setSaved(false);
    setTestResult(null);

    const payload = buildMercadoPagoCredentialsPayload(fields);
    if (!payload) {
      setEnvironmentError('Elige si esta conexión es de pruebas (sandbox) o de producción.');
      return;
    }

    setSubmitting(true);
    try {
      const updated = await apiFetch<SettingsResponse>('/v1/admin/settings/payments', {
        method: 'PATCH',
        body: JSON.stringify({ providers: { mercadopago: payload } }),
      });
      onSaved(updated);
      setSaved(true);
      setFields((prev) => ({ ...prev, privateKey: '', eventsSecret: '' }));
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'VALIDATION_FAILED') setErrors(fieldErrors(e));
        else setError(errorMessage(e));
      } else {
        setError('Ocurrió un error inesperado. Intenta de nuevo.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTestConnection() {
    setTestResult(null);
    setTesting(true);
    try {
      const result = await apiFetch<{ ok: boolean; error?: string }>(
        '/v1/admin/settings/payments/mercadopago/test-connection',
        { method: 'POST' },
      );
      setTestResult(result);
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof ApiError ? errorMessage(e) : 'No pudimos probar la conexión.' });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-sm font-medium text-foreground">Mercado Pago</h3>

      <div className="flex flex-col gap-1 rounded-md border border-border p-3 text-sm">
        <span>
          Estado: <strong>{mercadopago.connected ? 'Conectado' : 'No conectado'}</strong>
        </span>
        {mercadopago.connected ? (
          <>
            <span className="text-muted-foreground">Llave pública guardada: {mercadopago.publicKeyMasked}</span>
            <span className="text-muted-foreground">
              Entorno: {mercadopago.sandbox ? 'Sandbox (pruebas)' : 'Producción'}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">Aún no has guardado credenciales de Mercado Pago.</span>
        )}
      </div>

      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        {error ? <Alert variant="error">{error}</Alert> : null}
        {errors.providers ? <Alert variant="error">{errors.providers}</Alert> : null}
        {saved ? <Alert variant="success">Los cambios se guardaron correctamente.</Alert> : null}

        <p className="text-sm text-muted-foreground">
          Debes volver a ingresar todas tus credenciales de Mercado Pago cada vez que actualices esta configuración —
          se guardan como un solo bloque, así que un cambio parcial (por ejemplo, solo el entorno) también requiere
          reescribir la llave pública, la llave privada y elegir el entorno de nuevo.
        </p>

        <FormField label="Llave pública (Public Key)" htmlFor="mercadopago-public-key">
          <Input
            value={fields.publicKey}
            onChange={(event) => update({ publicKey: event.target.value })}
            placeholder="APP_USR-… o TEST-…"
            required
          />
        </FormField>

        <FormField label="Access Token (llave privada)" htmlFor="mercadopago-private-key">
          <Input
            type="password"
            value={fields.privateKey}
            onChange={(event) => update({ privateKey: event.target.value })}
            placeholder="Vuelve a escribir tu Access Token"
            required
          />
        </FormField>

        <FormField label="Firma secreta de webhooks (para verificar notificaciones)" htmlFor="mercadopago-events-secret">
          <Input
            type="password"
            value={fields.eventsSecret}
            onChange={(event) => update({ eventsSecret: event.target.value })}
            placeholder="Necesario para confirmar pagos automáticamente vía webhook"
          />
        </FormField>
        <p className="-mt-2 text-xs text-muted-foreground">
          Técnicamente opcional, pero sin esta firma los webhooks de Mercado Pago (confirmaciones y rechazos de pago)
          no se pueden verificar y la tienda nunca marcará un pedido como pagado automáticamente.
        </p>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-foreground">Entorno</span>
          {environmentError ? <Alert variant="error">{environmentError}</Alert> : null}
          <div className="flex gap-4">
            <div className="flex items-center gap-2">
              <input
                id="mercadopago-env-sandbox"
                type="radio"
                name="mercadopago-environment"
                className="h-4 w-4"
                checked={fields.sandbox === true}
                onChange={() => update({ sandbox: true })}
              />
              <Label htmlFor="mercadopago-env-sandbox">Sandbox (pruebas)</Label>
            </div>
            <div className="flex items-center gap-2">
              <input
                id="mercadopago-env-production"
                type="radio"
                name="mercadopago-environment"
                className="h-4 w-4"
                checked={fields.sandbox === false}
                onChange={() => update({ sandbox: false })}
              />
              <Label htmlFor="mercadopago-env-production">Producción</Label>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            No hay un entorno seleccionado por defecto: debes elegir uno explícitamente cada vez, para evitar dejar
            accidentalmente una tienda en modo de pruebas (o viceversa).
          </p>
        </div>

        <Button type="submit" disabled={submitting} className="self-start">
          {submitting ? 'Guardando…' : 'Guardar'}
        </Button>
      </form>

      <div className="flex flex-col gap-2 rounded-md border border-border p-3">
        <p className="text-sm text-muted-foreground">
          "Probar conexión" prueba las credenciales que ya están <strong>guardadas</strong> en el servidor, no lo
          que hayas escrito en este formulario sin guardar todavía. Si acabas de cambiar tus credenciales, guarda
          primero y luego prueba la conexión.
        </p>
        {testResult ? (
          <Alert variant={testResult.ok ? 'success' : 'error'}>
            {testResult.ok ? 'Conexión exitosa.' : (testResult.error ?? 'La conexión falló.')}
          </Alert>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="self-start"
          disabled={!mercadopago.connected || testing}
          onClick={() => void handleTestConnection()}
        >
          {testing ? 'Probando…' : 'Probar conexión'}
        </Button>
        {!mercadopago.connected ? (
          <p className="text-xs text-muted-foreground">
            Guarda tus credenciales de Mercado Pago antes de probar la conexión.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** ePayco sub-form: same shape/posture as `WompiSection`/`MercadoPagoSection`
 * (blank-on-every-mount secret fields, explicit no-default sandbox/
 * production choice, independent `providers.epayco` PATCH merge, "Probar
 * conexión" tests the already-SAVED credentials). The genuinely different
 * part — and the one this component must get right, per design doc decision
 * 4/7's explicit UX-risk callout — is that ePayco has TWO structurally
 * unrelated secret pairs, not one:
 *
 *  - `publicKey`/`privateKey` map to ePayco's own `PUBLIC_KEY`/`PRIVATE_KEY`,
 *    found in the main API-keys section of the ePayco dashboard, used only
 *    for the login/session-create calls that let a merchant accept a
 *    checkout at all.
 *  - `epaycoCustomerId`/`eventsSecret` map to ePayco's `P_CUST_ID_CLIENTE`/
 *    `P_KEY` — the "confirmation signature" pair ePayco uses to sign the
 *    `x_signature` field on its confirmation POST. These live in a
 *    DIFFERENT section of the ePayco dashboard (its own "Secret Keys"
 *    section — design doc decision 7), structurally unrelated to
 *    `PUBLIC_KEY`/`PRIVATE_KEY` above, and are needed only for
 *    `EpaycoProvider.verifyAndParseWebhook`, never for checkout creation.
 *
 * `P_CUST_ID_CLIENTE`/`P_KEY` are ePayco's own real dashboard field names —
 * verified against docs.epayco.com during this phase's Task 3 research (see
 * `packages/payments/src/epayco.ts`'s `requireEventsSecret`/
 * `requireEpaycoCustomerId`, which cite the same two names in their error
 * messages) — reused here directly rather than re-derived, and used
 * VERBATIM in this form's sub-heading/labels rather than a generic "webhook
 * secret" label a merchant could never map back to what they actually see in
 * their own ePayco dashboard. */
function EpaycoSection({ settings, onSaved }: TabProps) {
  const epayco = settings.payments.providers.epayco;

  const [fields, setFields] = useState<EpaycoFormFields>(BLANK_EPAYCO_FORM);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);

  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);

  function update(patch: Partial<EpaycoFormFields>) {
    setFields((prev) => ({ ...prev, ...patch }));
    setSaved(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setErrors({});
    setEnvironmentError(null);
    setSaved(false);
    setTestResult(null);

    const payload = buildEpaycoCredentialsPayload(fields);
    if (!payload) {
      setEnvironmentError('Elige si esta conexión es de pruebas (sandbox) o de producción.');
      return;
    }

    setSubmitting(true);
    try {
      const updated = await apiFetch<SettingsResponse>('/v1/admin/settings/payments', {
        method: 'PATCH',
        body: JSON.stringify({ providers: { epayco: payload } }),
      });
      onSaved(updated);
      setSaved(true);
      setFields((prev) => ({ ...prev, privateKey: '', eventsSecret: '', epaycoCustomerId: '' }));
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'VALIDATION_FAILED') setErrors(fieldErrors(e));
        else setError(errorMessage(e));
      } else {
        setError('Ocurrió un error inesperado. Intenta de nuevo.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTestConnection() {
    setTestResult(null);
    setTesting(true);
    try {
      const result = await apiFetch<{ ok: boolean; error?: string }>(
        '/v1/admin/settings/payments/epayco/test-connection',
        { method: 'POST' },
      );
      setTestResult(result);
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof ApiError ? errorMessage(e) : 'No pudimos probar la conexión.' });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-sm font-medium text-foreground">ePayco</h3>

      <div className="flex flex-col gap-1 rounded-md border border-border p-3 text-sm">
        <span>
          Estado: <strong>{epayco.connected ? 'Conectado' : 'No conectado'}</strong>
        </span>
        {epayco.connected ? (
          <>
            <span className="text-muted-foreground">Llave pública guardada: {epayco.publicKeyMasked}</span>
            <span className="text-muted-foreground">Entorno: {epayco.sandbox ? 'Sandbox (pruebas)' : 'Producción'}</span>
          </>
        ) : (
          <span className="text-muted-foreground">Aún no has guardado credenciales de ePayco.</span>
        )}
      </div>

      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        {error ? <Alert variant="error">{error}</Alert> : null}
        {errors.providers ? <Alert variant="error">{errors.providers}</Alert> : null}
        {saved ? <Alert variant="success">Los cambios se guardaron correctamente.</Alert> : null}

        <p className="text-sm text-muted-foreground">
          Debes volver a ingresar todas tus credenciales de ePayco cada vez que actualices esta configuración — se
          guardan como un solo bloque, así que un cambio parcial (por ejemplo, solo el entorno) también requiere
          reescribir todos los campos de abajo y elegir el entorno de nuevo.
        </p>

        <FormField label="Llave pública (PUBLIC_KEY)" htmlFor="epayco-public-key">
          <Input
            value={fields.publicKey}
            onChange={(event) => update({ publicKey: event.target.value })}
            placeholder="Tu PUBLIC_KEY de ePayco"
            required
          />
        </FormField>

        <FormField label="Llave privada (PRIVATE_KEY)" htmlFor="epayco-private-key">
          <Input
            type="password"
            value={fields.privateKey}
            onChange={(event) => update({ privateKey: event.target.value })}
            placeholder="Vuelve a escribir tu PRIVATE_KEY"
            required
          />
        </FormField>

        <p className="text-xs text-muted-foreground">
          Estas dos llaves están en la sección principal de llaves de API de tu panel de ePayco, y son las únicas
          que ePayco necesita para procesar un cobro.
        </p>

        <div className="flex flex-col gap-3 rounded-md border border-dashed border-border p-3">
          <div>
            <h4 className="text-sm font-medium text-foreground">Firma de confirmación (P_CUST_ID_CLIENTE / P_KEY)</h4>
            <p className="text-xs text-muted-foreground">
              Estos dos valores vienen de una sección DISTINTA del panel de ePayco — la sección "Secret Keys" (llaves
              secretas), no la de PUBLIC_KEY/PRIVATE_KEY de arriba. ePayco los usa para firmar la confirmación de cada
              pago; sin ellos, la tienda no puede verificar que una notificación de pago realmente viene de ePayco y
              nunca marcará un pedido como pagado automáticamente.
            </p>
          </div>

          <FormField label="P_CUST_ID_CLIENTE" htmlFor="epayco-customer-id">
            <Input
              type="password"
              value={fields.epaycoCustomerId}
              onChange={(event) => update({ epaycoCustomerId: event.target.value })}
              placeholder="Tu P_CUST_ID_CLIENTE (sección Secret Keys de ePayco)"
            />
          </FormField>

          <FormField label="P_KEY" htmlFor="epayco-events-secret">
            <Input
              type="password"
              value={fields.eventsSecret}
              onChange={(event) => update({ eventsSecret: event.target.value })}
              placeholder="Tu P_KEY (sección Secret Keys de ePayco)"
            />
          </FormField>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-foreground">Entorno</span>
          {environmentError ? <Alert variant="error">{environmentError}</Alert> : null}
          <div className="flex gap-4">
            <div className="flex items-center gap-2">
              <input
                id="epayco-env-sandbox"
                type="radio"
                name="epayco-environment"
                className="h-4 w-4"
                checked={fields.sandbox === true}
                onChange={() => update({ sandbox: true })}
              />
              <Label htmlFor="epayco-env-sandbox">Sandbox (pruebas)</Label>
            </div>
            <div className="flex items-center gap-2">
              <input
                id="epayco-env-production"
                type="radio"
                name="epayco-environment"
                className="h-4 w-4"
                checked={fields.sandbox === false}
                onChange={() => update({ sandbox: false })}
              />
              <Label htmlFor="epayco-env-production">Producción</Label>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            No hay un entorno seleccionado por defecto: debes elegir uno explícitamente cada vez, para evitar dejar
            accidentalmente una tienda en modo de pruebas (o viceversa).
          </p>
        </div>

        <Button type="submit" disabled={submitting} className="self-start">
          {submitting ? 'Guardando…' : 'Guardar'}
        </Button>
      </form>

      <div className="flex flex-col gap-2 rounded-md border border-border p-3">
        <p className="text-sm text-muted-foreground">
          "Probar conexión" prueba las credenciales que ya están <strong>guardadas</strong> en el servidor, no lo
          que hayas escrito en este formulario sin guardar todavía. Si acabas de cambiar tus credenciales, guarda
          primero y luego prueba la conexión.
        </p>
        {testResult ? (
          <Alert variant={testResult.ok ? 'success' : 'error'}>
            {testResult.ok ? 'Conexión exitosa.' : (testResult.error ?? 'La conexión falló.')}
          </Alert>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="self-start"
          disabled={!epayco.connected || testing}
          onClick={() => void handleTestConnection()}
        >
          {testing ? 'Probando…' : 'Probar conexión'}
        </Button>
        {!epayco.connected ? (
          <p className="text-xs text-muted-foreground">Guarda tus credenciales de ePayco antes de probar la conexión.</p>
        ) : null}
      </div>
    </div>
  );
}
