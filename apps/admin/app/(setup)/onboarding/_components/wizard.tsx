'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Card, CardContent, CardHeader, CardTitle, Spinner } from '@ventia/ui';
import { ONBOARDING_STEPS, type OnboardingStep } from '@ventia/core';
import { ApiError, apiFetch } from '../../../../lib/api';
import { errorMessage } from '../../../../lib/errors';
import { ChecklistPanel } from '../../../_components/checklist-panel';
import { Stepper } from './stepper';
import { STEP_ORDER, type WizardStepKey } from './wizard-steps';
import { CreateStoreStep } from './create-store-step';
import { StoreInfoStep } from './store-info-step';
import { BrandingStep } from './branding-step';
import { ProductsStep } from './products-step';
import { PaymentsStep } from './payments-step';

interface OnboardingGetResponse {
  steps: Partial<Record<OnboardingStep, { done: boolean; completedAt: string }>>;
}

export interface OnboardingWizardProps {
  /** `false` for a `no-tenant` session (a freshly signed-up user) — the
   * wizard starts at `create-store`. Enforcement of who may actually PATCH
   * each step lives entirely server-side (owner-only — see this app's
   * task-3 brief); this prop only decides the wizard's starting stage. */
  hasTenant: boolean;
}

/** Client orchestrator for the onboarding wizard: resumes at whichever step
 * `GET /v1/admin/onboarding` reports as not-done yet (in `@ventia/core`'s
 * `ONBOARDING_STEPS` order), and re-fetches that state after the
 * tenant-provisioning step so a fresh signup lands on `store_info` next. */
export function OnboardingWizard({ hasTenant: initialHasTenant }: OnboardingWizardProps) {
  const [hasTenant, setHasTenant] = useState(initialHasTenant);
  const [doneSteps, setDoneSteps] = useState<ReadonlySet<WizardStepKey>>(new Set());
  const [current, setCurrent] = useState<WizardStepKey>(initialHasTenant ? 'store_info' : 'create-store');
  const [loading, setLoading] = useState(initialHasTenant);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadSteps = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await apiFetch<OnboardingGetResponse>('/v1/admin/onboarding');
      const done = new Set<WizardStepKey>(['create-store']);
      let firstPending: WizardStepKey = 'checklist';
      for (const step of ONBOARDING_STEPS) {
        if (result.steps[step]?.done) {
          done.add(step);
        } else if (firstPending === 'checklist') {
          firstPending = step;
        }
      }
      setDoneSteps(done);
      setCurrent(firstPending);
    } catch (e) {
      setLoadError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (hasTenant) void loadSteps();
  }, [hasTenant, loadSteps]);

  function handleTenantCreated() {
    // The tenant + membership now exist server-side (session context is
    // resolved per-request from the DB, not cached in the session cookie —
    // see services/api/src/auth/session-context.ts), so the very next
    // GET /v1/admin/onboarding (triggered by the effect above once
    // `hasTenant` flips) already succeeds without a page reload.
    setHasTenant(true);
  }

  function handleStepDone(step: WizardStepKey) {
    setDoneSteps((prev) => new Set(prev).add(step));
    const index = STEP_ORDER.indexOf(step);
    setCurrent(STEP_ORDER[index + 1] ?? 'checklist');
  }

  function handleSelect(key: WizardStepKey) {
    if (key === current || doneSteps.has(key)) setCurrent(key);
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Cargando tu progreso…
      </div>
    );
  }

  if (loadError) {
    return <Alert variant="error">{loadError}</Alert>;
  }

  return (
    <div>
      <Stepper currentKey={current} doneKeys={doneSteps} onSelect={handleSelect} />
      {current === 'create-store' ? <CreateStoreStep onCreated={handleTenantCreated} /> : null}
      {current === 'store_info' ? <StoreInfoStep onDone={() => handleStepDone('store_info')} /> : null}
      {current === 'branding' ? <BrandingStep onDone={() => handleStepDone('branding')} /> : null}
      {current === 'products' ? <ProductsStep onDone={() => handleStepDone('products')} /> : null}
      {current === 'payments' ? <PaymentsStep onDone={() => handleStepDone('payments')} /> : null}
      {current === 'checklist' ? (
        <Card>
          <CardHeader>
            <CardTitle>Lista de lanzamiento</CardTitle>
          </CardHeader>
          <CardContent>
            <ChecklistPanel />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
