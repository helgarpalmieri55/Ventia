/** One row-level validation problem, matching the API's `RowError` shape
 * (services/api/src/csv-import/csv-parser.ts): `row` is 1-indexed (`0` is
 * reserved server-side for whole-file problems), `column` is the CSV header
 * name, `message` is already es-CO copy safe to show a merchant as-is. */
export interface RowError {
  row: number;
  column: string;
  message: string;
}

/** Raw `POST /v1/admin/import/dry-run` response body (see
 * `CsvImportService.dryRun`'s `DryRunResult`). `errors` already arrives
 * capped at 100 entries server-side, but `invalid` counts every distinct
 * invalid row in the whole file, not just the ones represented in the
 * (possibly truncated) `errors` array. */
export interface DryRunResponse {
  valid: number;
  invalid: number;
  creates: number;
  updates: number;
  errors: RowError[];
  limitExceeded: boolean;
}

/** How many error rows the importar page's table ever renders. Mirrors the
 * API's own `MAX_ERRORS_RETURNED` (csv-import.service.ts) — re-slicing to
 * the same number here is a client-side safety net, not a real cap (the
 * server never actually sends more than this). */
export const MAX_DISPLAYED_ERRORS = 100;

/** View model the importar page renders from, derived from a raw dry-run
 * response. Keeping this as a pure function (rather than inlining the
 * derivation in the page component) is what makes `moreErrorRows` — the
 * trickiest bit of arithmetic here — unit-testable without a DOM. */
export interface DryRunModel {
  valid: number;
  invalid: number;
  creates: number;
  updates: number;
  errors: RowError[];
  /** Distinct invalid rows NOT represented in `errors`, e.g. because the
   * server's 100-entry cap landed mid-way through a row that has multiple
   * column errors, leaving later rows' errors out entirely. Renders as the
   * "y N más…" note under the errors table; `0` means every invalid row has
   * at least one error shown. */
  moreErrorRows: number;
  limitExceeded: boolean;
}

/** Maps a raw dry-run response to the importar page's view model. */
export function dryRunToModel(response: DryRunResponse): DryRunModel {
  const errors = response.errors.slice(0, MAX_DISPLAYED_ERRORS);
  const shownRows = new Set(errors.map((e) => e.row)).size;
  const moreErrorRows = Math.max(0, response.invalid - shownRows);

  return {
    valid: response.valid,
    invalid: response.invalid,
    creates: response.creates,
    updates: response.updates,
    errors,
    moreErrorRows,
    limitExceeded: response.limitExceeded,
  };
}

/** Whether the commit button should be enabled: a dry-run must have run on
 * the CURRENT csv text (`dirty` is true the moment the user edits the file
 * picker/textarea after their last dry-run, so any edit invalidates the
 * button until they dry-run again), with zero invalid rows and the plan
 * limit not exceeded (a 402 the server would reject anyway — no point
 * letting the merchant fire a commit that's guaranteed to bounce). */
export function canCommit(model: DryRunModel | null, dirty: boolean): boolean {
  if (!model || dirty) return false;
  return model.invalid === 0 && !model.limitExceeded;
}
