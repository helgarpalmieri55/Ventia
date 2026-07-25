import { describe, expect, it } from 'vitest';
import { checklistStepClickable } from '../app/(setup)/onboarding/_components/wizard-steps';

describe('checklistStepClickable', () => {
  it('is not clickable when no steps are done', () => {
    expect(checklistStepClickable(new Set())).toBe(false);
  });

  it('is not clickable when only some of the 4 onboarding steps are done', () => {
    expect(checklistStepClickable(new Set(['store_info', 'branding']))).toBe(false);
  });

  it('this is the regression case: is clickable once all 4 real onboarding steps are done, even without a stored checklist entry', () => {
    expect(checklistStepClickable(new Set(['store_info', 'branding', 'products', 'payments']))).toBe(true);
  });

  it('extra unrelated keys (e.g. create-store) do not affect the result either way', () => {
    expect(
      checklistStepClickable(new Set(['create-store', 'store_info', 'branding', 'products', 'payments'])),
    ).toBe(true);
    expect(checklistStepClickable(new Set(['create-store']))).toBe(false);
  });
});
