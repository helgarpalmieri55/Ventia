/** Settings snapshot merge helpers for the onboarding wizard.
 *
 * When BrandingStep or PaymentsStep submit successfully, their new values
 * are propagated back into the wizard's `settings` state so any later
 * remount pre-fills from fresh data rather than the original snapshot. */

export interface SettingsGetResponse {
  theme: Record<string, unknown>;
  payments: { codEnabled: boolean };
}

export interface BrandingSubmit {
  theme: Record<string, unknown>;
}

export interface PaymentsSubmit {
  codEnabled: boolean;
}

/** Merges a newly-saved branding theme into the wizard's settings snapshot.
 * Because `PUT /v1/admin/settings/theme` is a full replace, the branding
 * submission carries the complete theme object — merge by wholesale replacement. */
export function mergeSavedSettings(
  prev: SettingsGetResponse | null,
  saved: BrandingSubmit,
): SettingsGetResponse {
  if (!prev) {
    return {
      theme: saved.theme,
      payments: { codEnabled: true }, // fallback default if settings were never fetched
    };
  }
  return {
    ...prev,
    theme: saved.theme,
  };
}

/** Merges a newly-saved payments setting into the wizard's settings snapshot.
 * Only the `codEnabled` flag changes. */
export function mergeSavedPaymentsSettings(
  prev: SettingsGetResponse | null,
  saved: PaymentsSubmit,
): SettingsGetResponse {
  if (!prev) {
    return {
      theme: {},
      payments: { codEnabled: saved.codEnabled },
    };
  }
  return {
    ...prev,
    payments: { codEnabled: saved.codEnabled },
  };
}
