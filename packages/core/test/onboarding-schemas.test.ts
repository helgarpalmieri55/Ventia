import { describe, expect, it } from 'vitest';
import { onboardingStepSchema, tenantProvisionSchema } from '../src/onboarding-schemas';

describe('tenantProvisionSchema', () => {
  it('accepts a minimal valid input', () => {
    const p = tenantProvisionSchema.parse({ storeName: 'Mi Tienda' });
    expect(p.slug).toBeUndefined();
  });
  it('rejects a too-short storeName', () => {
    expect(() => tenantProvisionSchema.parse({ storeName: 'x' })).toThrow();
  });
});

describe('onboardingStepSchema', () => {
  it('accepts a step with no data', () => {
    const s = onboardingStepSchema.parse({ step: 'store_info' });
    expect(s.data).toBeUndefined();
  });
  it('rejects an unknown step', () => {
    expect(() => onboardingStepSchema.parse({ step: 'shipping' })).toThrow();
  });
  it('validates store_info data fields', () => {
    expect(() =>
      onboardingStepSchema.parse({ step: 'store_info', data: { contactEmail: 'not-an-email' } }),
    ).toThrow();
    const s = onboardingStepSchema.parse({
      step: 'store_info',
      data: { contactEmail: 'a@b.co', category: 'moda' },
    });
    expect(s.data).toMatchObject({ contactEmail: 'a@b.co' });
  });
  it('validates payments data requires codEnabled boolean', () => {
    expect(() => onboardingStepSchema.parse({ step: 'payments', data: { codEnabled: 'yes' } })).toThrow();
    const s = onboardingStepSchema.parse({ step: 'payments', data: { codEnabled: true } });
    expect(s.data).toMatchObject({ codEnabled: true });
  });
  it('ignores data for branding/products steps (no persisted shape yet)', () => {
    const s = onboardingStepSchema.parse({ step: 'branding', data: { anything: 'goes' } });
    expect(s.data).toMatchObject({ anything: 'goes' });
  });
});
