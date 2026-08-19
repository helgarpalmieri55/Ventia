'use client';

import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Dialog, FormField, Input } from '@ventia/ui';
import {
  impersonationEntryHref,
  platformErrorText,
  startImpersonation,
  type PlatformTenantDetail,
} from '../../../../../lib/platform-api';

export interface ImpersonationPanelProps {
  tenant: PlatformTenantDetail;
}

/**
 * The entry point for operator impersonation
 * (docs/superpowers/specs/2026-08-19-impersonation-design.md).
 *
 * ## Why this is a confirmation and not a link
 *
 * Everything else on this page acts ON a merchant's account from the outside,
 * and is recorded as such. This one puts the operator INSIDE it: for the next
 * thirty minutes their requests resolve to this tenant, and the merchant's own
 * audit log will show a Ventia operator moving around in their store. The
 * merchant did not ask for that and will not be notified.
 *
 * So it asks first, and the dialog spends its words on the two things an
 * operator needs to have understood before clicking rather than after:
 *
 *   WHAT THEY MAY DO. Reads only. The write allow-list ships empty
 *   (`services/api/src/auth/impersonation-policy.ts`), so a write attempt
 *   fails with a 403 rather than doing something surprising. Saying so up
 *   front turns "why did that button not work" into an expectation.
 *
 *   THAT IT IS RECORDED. Under their own name — that is the whole point of
 *   the design's chosen shape, and an operator should know it is true rather
 *   than assume it is not.
 *
 * The `reason` is optional, matching the API (§3 makes issuing itself the
 * audited event; the reason is colour, not the record). It is offered because
 * an operator reading their own audit trail in three weeks will want it, not
 * because anything is gated on it.
 *
 * ## Why it is not the destructive-confirmation pattern
 *
 * `StatusPanel` makes you type the tenant's slug to suspend. This does not,
 * deliberately. Impersonating the wrong store is recoverable in a way that
 * suspending the wrong store is not: nothing changes, the banner names the
 * store you actually landed in, and leaving is one click. Making every
 * operator action feel equally grave is how the grave one stops registering.
 */
export function ImpersonationPanel({ tenant }: ImpersonationPanelProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await startImpersonation(tenant.id, reason);
      // A FULL page load, not `router.push` — the merchant shell resolves the
      // session server-side, so a client navigation would render it from a
      // tree built before the grant cookie existed and the banner would be
      // missing. See `impersonationEntryHref`.
      window.location.assign(impersonationEntryHref());
    } catch (e) {
      setError(platformErrorText(e));
      setSubmitting(false);
    }
    // No `finally`: on success the page is navigating away, and re-enabling
    // the button first would offer a second click that starts a second
    // session.
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Entrar a la tienda</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Abre el panel de {tenant.name} como lo ve el comerciante, durante 30 minutos y solo para consultar.
          Queda registrado a tu nombre.
        </p>
        <Button type="button" variant="secondary" className="self-start" onClick={() => setOpen(true)}>
          Entrar a la tienda
        </Button>

        <Dialog open={open} onClose={() => setOpen(false)}>
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-1">
              <h2 className="text-lg font-medium text-foreground">Entrar a {tenant.name}</h2>
              <p className="text-sm text-muted-foreground">
                <span className="font-mono">{tenant.slug}</span>
              </p>
            </div>

            {error ? <Alert variant="error">{error}</Alert> : null}

            <ul className="list-inside list-disc text-sm text-muted-foreground">
              <li>La sesión dura 30 minutos y no se puede extender.</li>
              <li>Solo puedes consultar: cualquier cambio será rechazado.</li>
              <li>Todo queda en la auditoría de la tienda, a tu nombre.</li>
              <li>El comerciante no recibe ningún aviso.</li>
            </ul>

            <FormField label="Motivo (opcional)" htmlFor="impersonationReason">
              <Input
                id="impersonationReason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={200}
                placeholder="Ej.: revisar el pedido VNT-1042 que el comerciante reportó"
              />
            </FormField>

            <div className="flex gap-2">
              <Button type="submit" disabled={submitting}>
                {submitting ? 'Entrando…' : 'Entrar a la tienda'}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={submitting}>
                Cancelar
              </Button>
            </div>
          </form>
        </Dialog>
      </CardContent>
    </Card>
  );
}
