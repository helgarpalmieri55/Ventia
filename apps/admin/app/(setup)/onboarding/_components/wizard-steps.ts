import type { OnboardingStep } from '@ventia/core';

/** `create-store` (provisioning the tenant itself) and `checklist` (the
 * final launch screen) aren't part of `@ventia/core`'s `ONBOARDING_STEPS`
 * (those 4 — store_info/branding/products/payments — are exactly the steps
 * `PATCH /v1/admin/onboarding` accepts); they're wizard-only stages layered
 * on top for a signed-up-but-tenant-less session and the launch checklist. */
export type WizardStepKey = 'create-store' | OnboardingStep | 'checklist';

export const WIZARD_STEP_DEFS: ReadonlyArray<{ key: WizardStepKey; label: string }> = [
  { key: 'create-store', label: 'Tu tienda' },
  { key: 'store_info', label: 'Información' },
  { key: 'branding', label: 'Marca' },
  { key: 'products', label: 'Productos' },
  { key: 'payments', label: 'Pagos' },
  { key: 'checklist', label: 'Lanzar' },
];

/** The order steps advance through after `create-store` — the same order
 * `@ventia/core`'s `ONBOARDING_STEPS` declares, kept as its own constant here
 * (rather than re-exporting `ONBOARDING_STEPS` directly) so this module is
 * the single place that also knows `checklist` comes right after `payments`. */
export const STEP_ORDER: readonly WizardStepKey[] = ['store_info', 'branding', 'products', 'payments', 'checklist'];
