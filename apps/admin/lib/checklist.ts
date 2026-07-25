/** The launch checklist shape returned by `GET /v1/admin/onboarding`'s
 * `checklist` field and `POST /v1/admin/launch`'s 422 `LAUNCH_CHECKLIST_INCOMPLETE`
 * error `details` (see services/api/src/onboarding/onboarding.service.ts's
 * `LaunchChecklist` / `buildChecklist`) — duplicated here as a plain type
 * rather than imported, since apps/admin has no dependency on services/api. */
export interface Checklist {
  storeInfo: boolean;
  emailVerified: boolean;
  hasActiveProduct: boolean;
  paymentsReady: boolean;
  ready: boolean;
}

/** The 4 actionable flags — `ready` itself is a derived summary, not a
 * checklist row a merchant can act on, so it's deliberately excluded from
 * both {@link checklistItems} and {@link missingItems}. */
export type ChecklistKey = 'storeInfo' | 'emailVerified' | 'hasActiveProduct' | 'paymentsReady';

export interface ChecklistItem {
  key: ChecklistKey;
  label: string;
  done: boolean;
}

const CHECKLIST_LABELS: Record<ChecklistKey, string> = {
  storeInfo: 'Información de la tienda completa',
  emailVerified: 'Correo electrónico verificado',
  hasActiveProduct: 'Al menos un producto activo',
  paymentsReady: 'Método de pago configurado',
};

const CHECKLIST_KEYS: readonly ChecklistKey[] = ['storeInfo', 'emailVerified', 'hasActiveProduct', 'paymentsReady'];

/** Pure helper: turns a {@link Checklist} into the 4 rows the checklist
 * screen renders (wizard's final step and the standalone /lanzamiento
 * page), in a fixed order with es-CO labels. */
export function checklistItems(checklist: Checklist): ChecklistItem[] {
  return CHECKLIST_KEYS.map((key) => ({ key, label: CHECKLIST_LABELS[key], done: checklist[key] }));
}

/** Maps a `LAUNCH_CHECKLIST_INCOMPLETE` 422's `details` (an {@link
 * ApiError}.details, typed `unknown` — it comes straight off the network) to
 * the subset of items still pending. A key absent from `details` counts as
 * not done, matching how `buildChecklist` always emits all 4 booleans (a
 * missing key would only ever mean a malformed/unexpected payload, not "done").
 * Any non-object `details` degrades to an empty list rather than throwing. */
export function missingItems(details: unknown): ChecklistItem[] {
  if (typeof details !== 'object' || details === null) return [];
  const record = details as Record<string, unknown>;
  return CHECKLIST_KEYS.filter((key) => record[key] !== true).map((key) => ({
    key,
    label: CHECKLIST_LABELS[key],
    done: false,
  }));
}
