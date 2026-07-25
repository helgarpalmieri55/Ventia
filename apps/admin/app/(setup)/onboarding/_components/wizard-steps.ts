import { ONBOARDING_STEPS, type OnboardingStep } from '@ventia/core';

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

/** Whether the stepper's 'checklist' ("Lanzar") tab should be clickable.
 *
 * `doneSteps` never gets a stored 'checklist' entry — `handleStepDone` only
 * ever marks the 4 real `ONBOARDING_STEPS`, and 'checklist' has no `PATCH
 * /v1/admin/onboarding` step of its own to mark it done with. Before this
 * fix that meant the stepper's `isDone || isCurrent` check could never make
 * 'checklist' clickable again once the wizard navigated away from it (e.g.
 * back to 'payments' to tweak something) — a merchant who'd already reached
 * the launch screen had no way back to it except reloading the page.
 *
 * Deliberately derived here rather than stored: 'checklist' being reachable
 * is exactly equivalent to "every real step is done", so there is nothing to
 * persist — this just names that equivalence as a pure, testable check. */
export function checklistStepClickable(doneSteps: ReadonlySet<WizardStepKey>): boolean {
  return ONBOARDING_STEPS.every((step) => doneSteps.has(step));
}
