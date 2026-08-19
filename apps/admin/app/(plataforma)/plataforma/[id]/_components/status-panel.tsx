'use client';

import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Dialog, FormField, Input } from '@ventia/ui';
import { formatCOP } from '../../../../../lib/format';
import {
  reactivateTenant,
  storefrontEffectMessage,
  suspendConfirmationMatches,
  suspendConfirmationToken,
  suspendTenant,
  platformErrorText,
  type PlatformTenantDetail,
  type SetStatusResult,
} from '../../../../../lib/platform-api';

export interface StatusPanelProps {
  tenant: PlatformTenantDetail;
  onChanged: () => void | Promise<void>;
}

/**
 * Suspender / reactivar.
 *
 * ## Why the suspend confirmation is as heavy as it is
 *
 * Suspending is not "an action with consequences" in the abstract: within
 * seconds, a real Colombian business's storefront answers 503 to every
 * shopper, and nobody at that business was told it was about to happen. It is
 * the most destructive button in this entire product, and it is operated by
 * someone working through a list of companies that are not their own.
 *
 * So the dialog is built around the two mistakes actually available here:
 *
 * 1. **Right intent, wrong company.** Defended by making the confirmation
 *    token the TENANT'S OWN SLUG (see `suspendConfirmationToken`). A fixed
 *    word — the `ANONIMIZAR` pattern used on the merchant Clientes page — is
 *    typed from muscle memory by the third use and stops distinguishing rows.
 *    A per-tenant token cannot be produced without reading the identifier of
 *    the store on screen. The dialog also restates the name, the slug, the
 *    lifetime GMV and the order count, so "wrong company" has to survive
 *    seeing what that company is worth.
 * 2. **Acting without a record.** The reason is required (the API requires it
 *    too) and lands on the audit row with the operator's email.
 *
 * Reactivation is deliberately much lighter: it puts a store back ONLINE.
 * The failure mode of an over-eager reactivation is a store that works.
 */
export function StatusPanel({ tenant, onChanged }: StatusPanelProps) {
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [reactivateOpen, setReactivateOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SetStatusResult | null>(null);

  function openSuspend() {
    setReason('');
    setTyped('');
    setError(null);
    setResult(null);
    setSuspendOpen(true);
  }

  function openReactivate() {
    setNote('');
    setError(null);
    setResult(null);
    setReactivateOpen(true);
  }

  function closeAll() {
    setSuspendOpen(false);
    setReactivateOpen(false);
    setResult(null);
    setError(null);
  }

  async function handleSuspend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reason.trim() || !suspendConfirmationMatches(typed, tenant)) return;
    setError(null);
    setSubmitting(true);
    try {
      setResult(await suspendTenant(tenant.id, reason));
      await onChanged();
    } catch (e) {
      setError(platformErrorText(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReactivate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      setResult(await reactivateTenant(tenant.id, note));
      await onChanged();
    } catch (e) {
      setError(platformErrorText(e));
    } finally {
      setSubmitting(false);
    }
  }

  const suspended = tenant.status === 'suspended';
  const canSuspend = reason.trim().length > 0 && suspendConfirmationMatches(typed, tenant);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Estado de la cuenta</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {suspended ? (
          <>
            <Alert variant="error">
              Esta tienda está suspendida: sus dominios responden 503 y sus clientes no pueden comprar.
            </Alert>
            <div>
              <Button onClick={openReactivate}>Reactivar tienda</Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Suspender deja la tienda de <span className="font-medium text-foreground">{tenant.name}</span> fuera
              de línea de inmediato. No avisa al comerciante ni cancela sus pedidos.
            </p>
            <div>
              <Button variant="destructive" onClick={openSuspend}>
                Suspender tienda
              </Button>
            </div>
          </>
        )}
      </CardContent>

      {/* --- suspender --- */}
      <Dialog open={suspendOpen} onClose={closeAll} className="max-w-lg">
        {result ? (
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold text-foreground">Tienda suspendida</h2>
            <Alert variant={result.storefrontEffective === 'immediate' ? 'success' : 'warning'}>
              {storefrontEffectMessage(result)}
            </Alert>
            <p className="text-xs text-muted-foreground">
              Quedó registrado en la auditoría de plataforma: tu correo de operador, la cuenta afectada y el motivo
              que escribiste.
            </p>
            <div className="flex justify-end">
              <Button onClick={closeAll}>Cerrar</Button>
            </div>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={handleSuspend}>
            <h2 className="text-lg font-semibold text-foreground">Suspender una tienda ajena</h2>
            <Alert variant="error">
              Vas a dejar fuera de línea el negocio de otra empresa. En segundos, la tienda de{' '}
              <span className="font-medium">{tenant.name}</span> deja de responder y sus clientes ven un error en
              vez de poder comprar. El comerciante no recibe ningún aviso automático.
            </Alert>

            {/* The stakes, in numbers, next to the button that stops them. */}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-border p-3 text-sm">
              <dt className="text-muted-foreground">Comercio</dt>
              <dd className="text-foreground">{tenant.name}</dd>
              <dt className="text-muted-foreground">URL</dt>
              <dd className="font-mono text-foreground">{tenant.slug}</dd>
              <dt className="text-muted-foreground">Ventas históricas</dt>
              <dd className="text-foreground">
                {formatCOP(tenant.gmv.totalCents)} · {tenant.gmv.orders} pedido
                {tenant.gmv.orders === 1 ? '' : 's'}
              </dd>
            </dl>

            {error ? <Alert variant="error">{error}</Alert> : null}

            <FormField label="Motivo de la suspensión" htmlFor="suspender-motivo">
              <Input
                id="suspender-motivo"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Ej.: mora de 45 días / tienda fraudulenta reportada"
                maxLength={500}
                autoComplete="off"
              />
            </FormField>

            <FormField
              label={`Escribe la URL de la tienda (${suspendConfirmationToken(tenant)}) para confirmar`}
              htmlFor="suspender-confirmar"
            >
              <Input
                id="suspender-confirmar"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
              />
            </FormField>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={closeAll}>
                Cancelar
              </Button>
              <Button type="submit" variant="destructive" disabled={submitting || !canSuspend}>
                {submitting ? 'Suspendiendo…' : 'Suspender esta tienda'}
              </Button>
            </div>
          </form>
        )}
      </Dialog>

      {/* --- reactivar --- */}
      <Dialog open={reactivateOpen} onClose={closeAll}>
        {result ? (
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold text-foreground">Tienda reactivada</h2>
            <Alert variant={result.storefrontEffective === 'immediate' ? 'success' : 'warning'}>
              {storefrontEffectMessage(result)}
            </Alert>
            <div className="flex justify-end">
              <Button onClick={closeAll}>Cerrar</Button>
            </div>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={handleReactivate}>
            <h2 className="text-lg font-semibold text-foreground">Reactivar tienda</h2>
            <p className="text-sm text-muted-foreground">
              La tienda de <span className="font-medium text-foreground">{tenant.name}</span> vuelve a estar en
              línea de inmediato.
            </p>
            {error ? <Alert variant="error">{error}</Alert> : null}
            <FormField label="Nota para la auditoría (opcional)" htmlFor="reactivar-nota">
              <Input
                id="reactivar-nota"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Ej.: pago recibido el 19/08"
                maxLength={500}
                autoComplete="off"
              />
            </FormField>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={closeAll}>
                Cancelar
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? 'Reactivando…' : 'Reactivar'}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </Card>
  );
}
