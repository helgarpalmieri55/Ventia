'use client';

import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, FormField, Input } from '@ventia/ui';
import { ApiError, apiFetch } from '../../../../lib/api';
import { errorMessage } from '../../../../lib/errors';

interface PatchOnboardingResponse {
  steps: Record<string, unknown>;
}

export interface StoreInfoStepProps {
  onDone: () => void;
}

/** `store_info` step: `PATCH /v1/admin/onboarding { step: 'store_info', data }`
 * — all 4 fields are optional server-side (storeInfoDataSchema), so an empty
 * submit still marks the step done; the launch checklist's `storeInfo` flag
 * separately requires a `contactEmail` to actually be set (see
 * OnboardingService.buildChecklist), which the checklist screen surfaces. */
export function StoreInfoStep({ onDone }: StoreInfoStepProps) {
  const [category, setCategory] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch<PatchOnboardingResponse>('/v1/admin/onboarding', {
        method: 'PATCH',
        body: JSON.stringify({
          step: 'store_info',
          data: {
            ...(category ? { category } : {}),
            ...(contactEmail ? { contactEmail } : {}),
            ...(contactPhone ? { contactPhone } : {}),
            ...(description ? { description } : {}),
          },
        }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Información de tu tienda</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
          {error ? <Alert variant="error">{error}</Alert> : null}
          <FormField label="Categoría" htmlFor="category">
            <Input
              type="text"
              maxLength={60}
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              placeholder="Ej. Moda, Hogar, Belleza"
            />
          </FormField>
          <FormField label="Correo de contacto" htmlFor="contactEmail">
            <Input
              type="email"
              value={contactEmail}
              onChange={(event) => setContactEmail(event.target.value)}
              placeholder="contacto@tutienda.com"
            />
          </FormField>
          <FormField label="Teléfono de contacto" htmlFor="contactPhone">
            <Input
              type="tel"
              maxLength={20}
              value={contactPhone}
              onChange={(event) => setContactPhone(event.target.value)}
              placeholder="Ej. +57 300 000 0000"
            />
          </FormField>
          <FormField label="Descripción" htmlFor="description">
            <Input
              type="text"
              maxLength={500}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Cuéntales a tus clientes de qué se trata tu tienda"
            />
          </FormField>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Guardando…' : 'Continuar'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
