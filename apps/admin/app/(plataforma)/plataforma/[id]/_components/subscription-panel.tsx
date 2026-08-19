'use client';

import { useState, type FormEvent } from 'react';
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
  Select,
  Spinner,
} from '@ventia/ui';
import { formatCOP, formatDateBogota, formatLongDateBogota } from '../../../../../lib/format';
import {
  PLAN_IDS,
  PLAN_LABELS,
  SUBSCRIPTION_DUE_BADGE,
  SUBSCRIPTION_DUE_LABELS,
  getSubscription,
  parseSubscriptionForm,
  platformErrorText,
  recordSubscription,
  subscriptionDueNotice,
  subscriptionFormValues,
  subscriptionSaveNotice,
  type PlanId,
  type PlatformSubscription,
  type PlatformTenantDetail,
  type RecordSubscriptionResult,
  type SubscriptionFormErrors,
  type SubscriptionFormValues,
  type SubscriptionNotice,
} from '../../../../../lib/platform-api';

export interface SubscriptionPanelProps {
  tenant: PlatformTenantDetail;
  /** Re-reads the tenant. The PUT response carries the new subscription, but
   * not the rest of the page — and this panel's own copy tells the operator
   * things ("la tienda sigue suspendida") that the Estado panel above must
   * agree with. Patching half a screen from a mutation response is how a view
   * starts disagreeing with the database. */
  onChanged: () => void | Promise<void>;
}

function Notice({ notice }: { notice: SubscriptionNotice }) {
  return <Alert variant={notice.variant}>{notice.text}</Alert>;
}

/**
 * Suscripción — read plus edit (SPEC §6 M9, v1 manual billing).
 *
 * ## What this panel actually is
 *
 * There is no payment processor behind any of it. A merchant pays Ventia by
 * bank transfer, an operator sees the transfer land, and writes down "pagado
 * hasta el 30 de septiembre". That single recorded date is the ONLY input to
 * `subscription-sweep.worker.ts`, which is what takes a real Colombian
 * business offline when the grace window runs out. So this is not a billing
 * form; it is the control that decides whether a store keeps selling, and it
 * is built to read that way.
 *
 * ## Every date here comes from the server
 *
 * `dueState`, `suspendsOn`, `warnsOn`, `daysPastDue` and `graceDays` are
 * computed by the API from the same function the sweep acts on. Nothing in
 * this component adds days to anything. The grace window is a per-deployment
 * setting (`SUBSCRIPTION_GRACE_DAYS`), so a client-side "+7 days" would be a
 * confident, specific, wrong answer to "when does this store go dark" on any
 * deployment that tuned it — and it would disagree with the job that actually
 * does the suspending. See `subscriptionDueNotice`.
 *
 * They are also rendered in `America/Bogota`, not the browser's zone, because
 * `paidUntil` is a Bogotá calendar day stored as the instant it ends: a
 * `suspendsOn` of `2026-09-09T04:59:59.999Z` is **8 September** in Bogotá,
 * and telling an operator "9 de septiembre" would be a day late on the one
 * fact this panel exists to convey.
 *
 * ## Why the editor re-reads before it edits
 *
 * `PUT` carries the WHOLE subscription — that is deliberate on the API side
 * (a partial body cannot distinguish "no date" from "date omitted", and on
 * this field that ambiguity is a store staying up versus going down). The
 * cost is that an operator editing a stale copy silently reverts whatever
 * changed in the meantime. So opening the editor re-reads
 * `GET .../subscription` first, and says so if it could not.
 */
export function SubscriptionPanel({ tenant, onChanged }: SubscriptionPanelProps) {
  const subscription = tenant.subscription;

  const [open, setOpen] = useState(false);
  const [loadingForm, setLoadingForm] = useState(false);
  const [staleWarning, setStaleWarning] = useState<string | null>(null);
  const [values, setValues] = useState<SubscriptionFormValues>(() =>
    subscriptionFormValues(subscription, tenant.plan),
  );
  const [errors, setErrors] = useState<SubscriptionFormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RecordSubscriptionResult | null>(null);

  function seed(from: PlatformSubscription | null) {
    setValues(subscriptionFormValues(from, tenant.plan));
  }

  async function openEditor() {
    setErrors({});
    setError(null);
    setResult(null);
    setStaleWarning(null);
    seed(subscription);
    setOpen(true);

    setLoadingForm(true);
    try {
      const fresh = await getSubscription(tenant.id);
      seed(fresh.subscription);
    } catch {
      // Not fatal: the operator can still edit what the page loaded with. But
      // they are told, because a save from here overwrites the whole row.
      setStaleWarning(
        'No pudimos volver a leer la suscripción antes de editarla. Estás viendo lo que se cargó con la página; si alguien más la cambió hace un momento, guardar aquí lo sobrescribe.',
      );
    } finally {
      setLoadingForm(false);
    }
  }

  function close() {
    setOpen(false);
    setResult(null);
    setError(null);
    setErrors({});
    setStaleWarning(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseSubscriptionForm(values);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors({});
    setError(null);
    setSubmitting(true);
    try {
      setResult(await recordSubscription(tenant.id, parsed.body));
      await onChanged();
    } catch (e) {
      setError(platformErrorText(e));
    } finally {
      setSubmitting(false);
    }
  }

  const suspendsOnText = subscription?.suspendsOn ? formatLongDateBogota(subscription.suspendsOn) : null;
  const warnsOnText = subscription?.warnsOn ? formatLongDateBogota(subscription.warnsOn) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="flex flex-wrap items-center gap-3">
            Suscripción
            {subscription ? (
              <Badge variant={SUBSCRIPTION_DUE_BADGE[subscription.dueState]}>
                {SUBSCRIPTION_DUE_LABELS[subscription.dueState]}
              </Badge>
            ) : null}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {subscription ? (
          <>
            <Notice notice={subscriptionDueNotice(subscription)} />

            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Plan facturado</dt>
              <dd className="text-foreground">
                {PLAN_LABELS[subscription.plan]}
                {subscription.plan === tenant.plan ? null : (
                  <span className="ml-2 text-amber-700">
                    (el plan asignado es {PLAN_LABELS[tenant.plan]})
                  </span>
                )}
              </dd>
              <dt className="text-muted-foreground">Precio</dt>
              <dd className="text-foreground">{formatCOP(subscription.priceCents)}</dd>
              <dt className="text-muted-foreground">Pagado hasta</dt>
              <dd className="text-foreground">
                {subscription.paidUntil
                  ? (formatDateBogota(subscription.paidUntil) ?? 'Sin fecha registrada')
                  : 'Sin fecha registrada'}
              </dd>
              <dt className="text-muted-foreground">Aviso de suspensión</dt>
              <dd className="text-foreground">{warnsOnText ?? '—'}</dd>
              <dt className="text-muted-foreground">Se suspende sola</dt>
              <dd className="text-foreground">{suspendsOnText ?? '—'}</dd>
              <dt className="text-muted-foreground">Notas</dt>
              <dd className="text-foreground">{subscription.notes?.trim() || '—'}</dd>
              <dt className="text-muted-foreground">Última actualización</dt>
              <dd className="text-muted-foreground">{formatDateBogota(subscription.updatedAt) ?? '—'}</dd>
            </dl>

            <p className="text-xs text-muted-foreground">
              Fechas en hora de Colombia. La ventana de gracia de esta instalación es de {subscription.graceDays}{' '}
              día{subscription.graceDays === 1 ? '' : 's'} y la calcula el servidor, no esta pantalla.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Este comercio no tiene una suscripción registrada. Mientras no haya una fecha de pago, la suspensión
            automática no lo toca.
          </p>
        )}

        <div>
          <Button variant={subscription ? 'secondary' : 'default'} onClick={() => void openEditor()}>
            {subscription ? 'Editar suscripción' : 'Registrar suscripción'}
          </Button>
        </div>
      </CardContent>

      <Dialog open={open} onClose={close} className="max-w-lg">
        {result ? (
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold text-foreground">Suscripción guardada</h2>
            <Notice notice={subscriptionSaveNotice(result)} />
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-border p-3 text-sm">
              <dt className="text-muted-foreground">Pagado hasta</dt>
              <dd className="text-foreground">
                {result.subscription.paidUntil
                  ? (formatDateBogota(result.subscription.paidUntil) ?? 'Sin fecha registrada')
                  : 'Sin fecha registrada'}
              </dd>
              <dt className="text-muted-foreground">Se suspende sola</dt>
              <dd className="text-foreground">
                {result.subscription.suspendsOn
                  ? (formatLongDateBogota(result.subscription.suspendsOn) ?? '—')
                  : '—'}
              </dd>
            </dl>
            <p className="text-xs text-muted-foreground">
              Quedó registrado en la auditoría de plataforma con tu correo de operador, incluyendo el valor
              anterior de la fecha de pago.
            </p>
            <div className="flex justify-end">
              <Button onClick={close}>Cerrar</Button>
            </div>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <h2 className="text-lg font-semibold text-foreground">
              Suscripción de {tenant.name}
            </h2>
            <p className="text-sm text-muted-foreground">
              Esto no cobra nada ni consulta ninguna pasarela: es el registro manual de hasta cuándo está pagado
              este comercio. La fecha que guardes aquí es la que usa la suspensión automática.
            </p>

            {loadingForm ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner /> Leyendo la suscripción actual…
              </div>
            ) : null}
            {staleWarning ? <Alert variant="warning">{staleWarning}</Alert> : null}
            {error ? <Alert variant="error">{error}</Alert> : null}

            <FormField label="Plan facturado" htmlFor="suscripcion-plan" error={errors.plan}>
              <Select
                id="suscripcion-plan"
                value={values.plan}
                onChange={(event) => setValues((v) => ({ ...v, plan: event.target.value as PlanId }))}
                className="w-56"
                disabled={loadingForm}
              >
                {PLAN_IDS.map((value) => (
                  <option key={value} value={value}>
                    {PLAN_LABELS[value]}
                  </option>
                ))}
              </Select>
            </FormField>

            <FormField label="Precio mensual en pesos" htmlFor="suscripcion-precio" error={errors.price}>
              <Input
                id="suscripcion-precio"
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                value={values.price}
                onChange={(event) => setValues((v) => ({ ...v, price: event.target.value }))}
                placeholder="Ej.: 89000"
                className="w-56"
                disabled={loadingForm}
                autoComplete="off"
              />
            </FormField>

            <FormField
              label="Pagado hasta (déjalo vacío si no hay pago registrado)"
              htmlFor="suscripcion-pagado-hasta"
              error={errors.paidUntil}
            >
              <Input
                id="suscripcion-pagado-hasta"
                type="date"
                value={values.paidUntil}
                onChange={(event) => setValues((v) => ({ ...v, paidUntil: event.target.value }))}
                className="w-56"
                disabled={loadingForm}
              />
            </FormField>

            <FormField label="Notas (opcional)" htmlFor="suscripcion-notas" error={errors.notes}>
              <Input
                id="suscripcion-notas"
                value={values.notes}
                onChange={(event) => setValues((v) => ({ ...v, notes: event.target.value }))}
                placeholder="Ej.: transferencia Bancolombia, factura 0142"
                maxLength={1000}
                disabled={loadingForm}
                autoComplete="off"
              />
            </FormField>

            {tenant.status === 'suspended' ? (
              <Alert variant="warning">
                Esta tienda está suspendida. Guardar una fecha de pago la deja al día en la contabilidad, pero{' '}
                <span className="font-medium">no la vuelve a poner en línea</span>: eso se hace en Estado de la
                cuenta.
              </Alert>
            ) : null}

            <p className="text-xs text-muted-foreground">
              Se guarda como PUT: lo que quede en este formulario reemplaza la suscripción completa. Vaciar la
              fecha significa &laquo;sin pago registrado&raquo;, no &laquo;déjala como estaba&raquo;.
            </p>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={close}>
                Cancelar
              </Button>
              <Button type="submit" disabled={submitting || loadingForm}>
                {submitting ? 'Guardando…' : 'Guardar suscripción'}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </Card>
  );
}
