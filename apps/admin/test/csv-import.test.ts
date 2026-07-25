import { describe, expect, it } from 'vitest';
import { canCommit, dryRunToModel, type DryRunResponse } from '../lib/csv-import';

function response(partial: Partial<DryRunResponse> = {}): DryRunResponse {
  return {
    valid: 10,
    invalid: 0,
    creates: 10,
    updates: 0,
    errors: [],
    limitExceeded: false,
    ...partial,
  };
}

describe('dryRunToModel', () => {
  it('carries the summary counts through unchanged', () => {
    const model = dryRunToModel(response({ valid: 8, invalid: 2, creates: 5, updates: 3 }));
    expect(model.valid).toBe(8);
    expect(model.invalid).toBe(2);
    expect(model.creates).toBe(5);
    expect(model.updates).toBe(3);
  });

  it('passes errors through untouched when under the display cap', () => {
    const errors = [
      { row: 2, column: 'sku', message: 'sku es obligatorio' },
      { row: 3, column: 'price_cents', message: 'debe ser un número' },
    ];
    const model = dryRunToModel(response({ invalid: 2, errors }));
    expect(model.errors).toEqual(errors);
    expect(model.moreErrorRows).toBe(0);
  });

  it('caps displayed errors at 100 even if the server sent more', () => {
    const errors = Array.from({ length: 120 }, (_, i) => ({
      row: i + 1,
      column: 'sku',
      message: 'sku es obligatorio',
    }));
    const model = dryRunToModel(response({ invalid: 120, errors }));
    expect(model.errors).toHaveLength(100);
  });

  it('reports how many additional invalid rows are not represented in the shown errors', () => {
    // 100 error entries but all for the same 5 rows (multiple column errors
    // per row) while the server counted 8 distinct invalid rows overall.
    const errors = Array.from({ length: 100 }, (_, i) => ({
      row: (i % 5) + 1,
      column: 'sku',
      message: 'sku es obligatorio',
    }));
    const model = dryRunToModel(response({ invalid: 8, errors }));
    expect(model.moreErrorRows).toBe(3);
  });

  it('never reports a negative moreErrorRows', () => {
    const errors = [{ row: 1, column: 'sku', message: 'x' }];
    const model = dryRunToModel(response({ invalid: 0, errors }));
    expect(model.moreErrorRows).toBe(0);
  });

  it('flags limitExceeded through unchanged', () => {
    expect(dryRunToModel(response({ limitExceeded: true })).limitExceeded).toBe(true);
    expect(dryRunToModel(response({ limitExceeded: false })).limitExceeded).toBe(false);
  });
});

describe('canCommit', () => {
  const cleanModel = dryRunToModel(response({ invalid: 0, limitExceeded: false }));

  it('is false when there is no dry-run model yet', () => {
    expect(canCommit(null, false)).toBe(false);
  });

  it('is false when the text has been edited since the last dry-run', () => {
    expect(canCommit(cleanModel, true)).toBe(false);
  });

  it('is false when the dry-run found invalid rows', () => {
    const model = dryRunToModel(response({ invalid: 1 }));
    expect(canCommit(model, false)).toBe(false);
  });

  it('is false when the plan limit would be exceeded', () => {
    const model = dryRunToModel(response({ invalid: 0, limitExceeded: true }));
    expect(canCommit(model, false)).toBe(false);
  });

  it('is true when the dry-run is current, has no invalid rows, and is under the plan limit', () => {
    expect(canCommit(cleanModel, false)).toBe(true);
  });
});
