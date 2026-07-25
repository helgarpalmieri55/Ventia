import { describe, expect, it } from 'vitest';
import { checklistItems, missingItems, type Checklist } from '../lib/checklist';

const READY: Checklist = {
  storeInfo: true,
  emailVerified: true,
  hasActiveProduct: true,
  paymentsReady: true,
  ready: true,
};

describe('checklistItems', () => {
  it('maps all 4 flags to es-CO labelled items, in a fixed order, when everything is done', () => {
    const items = checklistItems(READY);

    expect(items).toEqual([
      { key: 'storeInfo', label: expect.any(String), done: true },
      { key: 'emailVerified', label: expect.any(String), done: true },
      { key: 'hasActiveProduct', label: expect.any(String), done: true },
      { key: 'paymentsReady', label: expect.any(String), done: true },
    ]);
    // Every label is distinct, non-empty es-CO copy — not a raw flag name.
    const labels = items.map((item) => item.label);
    expect(new Set(labels).size).toBe(4);
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toMatch(/^(storeInfo|emailVerified|hasActiveProduct|paymentsReady)$/);
    }
  });

  it('reflects a mixed checklist (some done, some not), ignoring the `ready` flag itself', () => {
    const items = checklistItems({
      storeInfo: true,
      emailVerified: false,
      hasActiveProduct: true,
      paymentsReady: false,
      ready: false,
    });

    expect(items).toHaveLength(4);
    expect(items.find((item) => item.key === 'storeInfo')?.done).toBe(true);
    expect(items.find((item) => item.key === 'emailVerified')?.done).toBe(false);
    expect(items.find((item) => item.key === 'hasActiveProduct')?.done).toBe(true);
    expect(items.find((item) => item.key === 'paymentsReady')?.done).toBe(false);
  });
});

describe('missingItems', () => {
  it('returns only the not-done items from a 422 details payload', () => {
    const missing = missingItems({
      storeInfo: true,
      emailVerified: false,
      hasActiveProduct: false,
      paymentsReady: true,
      ready: false,
    });

    expect(missing.map((item) => item.key)).toEqual(['emailVerified', 'hasActiveProduct']);
    expect(missing.every((item) => item.done === false)).toBe(true);
  });

  it('returns an empty list when every flag is already true', () => {
    expect(missingItems(READY)).toEqual([]);
  });

  it('treats a missing/undefined flag as not done', () => {
    const missing = missingItems({ storeInfo: true });
    expect(missing.map((item) => item.key).sort()).toEqual(
      ['emailVerified', 'hasActiveProduct', 'paymentsReady'].sort(),
    );
  });

  it('degrades to an empty list for a non-object details value, without throwing', () => {
    expect(missingItems(null)).toEqual([]);
    expect(missingItems(undefined)).toEqual([]);
    expect(missingItems('LAUNCH_CHECKLIST_INCOMPLETE')).toEqual([]);
    expect(missingItems(42)).toEqual([]);
  });
});
