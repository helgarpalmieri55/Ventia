'use client';

import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, FormField, Input } from '@ventia/ui';
import { ApiError, apiFetch } from '../../../../lib/api';
import { errorMessage } from '../../../../lib/errors';

interface ProvisionTenantResponse {
  tenant: { tenantId: string; slug: string; name: string; status: string };
  role: 'owner';
}

export interface CreateStoreStepProps {
  /** Fires once `POST /v1/admin/onboarding/tenant` succeeds — the wizard
   * re-fetches the (now-real) onboarding state and moves to `store_info`. */
  onCreated: () => void;
}

/** Step 0, shown only for a `no-tenant` session (a freshly signed-up user):
 * the one field the wizard needs to provision a tenant — the slug is derived
 * server-side from `storeName` (see tenantProvisionSchema / OnboardingService.
 * provisionTenant), so there's nothing else to collect here. */
export function CreateStoreStep({ onCreated }: CreateStoreStepProps) {
  const [storeName, setStoreName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch<ProvisionTenantResponse>('/v1/admin/onboarding/tenant', {
        method: 'POST',
        body: JSON.stringify({ storeName }),
      });
      onCreated();
    } catch (e) {
      setError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Crea tu tienda</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
          {error ? <Alert variant="error">{error}</Alert> : null}
          <FormField label="Nombre de tu tienda" htmlFor="storeName">
            <Input
              type="text"
              required
              minLength={2}
              maxLength={80}
              value={storeName}
              onChange={(event) => setStoreName(event.target.value)}
              placeholder="Ej. Tienda de Ana"
            />
          </FormField>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Creando tienda…' : 'Crear tienda'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
