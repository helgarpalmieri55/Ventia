import { describe, expect, it } from 'vitest';
import { mergeSavedSettings, mergeSavedPaymentsSettings, type SettingsGetResponse } from '../lib/settings-merge';

describe('mergeSavedSettings', () => {
  it('merges branding theme into a non-null settings snapshot, wholesale replacing theme', () => {
    const prev: SettingsGetResponse = {
      theme: { colors: { primary: '#111111', background: '#222222', foreground: '#333333' }, fontPair: 'inter-lora' },
      payments: { codEnabled: false },
    };

    const newTheme = { colors: { primary: '#ff0000', background: '#00ff00', foreground: '#0000ff' }, radius: 'lg' };
    const result = mergeSavedSettings(prev, { theme: newTheme });

    expect(result.theme).toEqual(newTheme);
    expect(result.payments.codEnabled).toBe(false); // payments unchanged
  });

  it('replaces theme with new values, even if empty', () => {
    const prev: SettingsGetResponse = {
      theme: { colors: { primary: '#111111', background: '#222222', foreground: '#333333' } },
      payments: { codEnabled: true },
    };

    const newTheme = {};
    const result = mergeSavedSettings(prev, { theme: newTheme });

    expect(result.theme).toEqual({});
    expect(result.payments.codEnabled).toBe(true);
  });

  it('handles null prev settings by creating a fresh snapshot with theme + fallback payments', () => {
    const newTheme = { colors: { primary: '#abcdef', background: '#123456', foreground: '#fedcba' } };
    const result = mergeSavedSettings(null, { theme: newTheme });

    expect(result.theme).toEqual(newTheme);
    expect(result.payments.codEnabled).toBe(true); // default fallback
  });
});

describe('mergeSavedPaymentsSettings', () => {
  it('merges payments codEnabled into a non-null settings snapshot, preserving theme', () => {
    const prev: SettingsGetResponse = {
      theme: { colors: { primary: '#111111', background: '#222222', foreground: '#333333' }, fontPair: 'inter-lora' },
      payments: { codEnabled: true },
    };

    const result = mergeSavedPaymentsSettings(prev, { codEnabled: false });

    expect(result.payments.codEnabled).toBe(false);
    expect(result.theme).toEqual(prev.theme); // theme unchanged
  });

  it('toggles codEnabled from false to true', () => {
    const prev: SettingsGetResponse = {
      theme: { colors: { primary: '#111111' } },
      payments: { codEnabled: false },
    };

    const result = mergeSavedPaymentsSettings(prev, { codEnabled: true });

    expect(result.payments.codEnabled).toBe(true);
  });

  it('handles null prev settings by creating a fresh snapshot with codEnabled + empty theme fallback', () => {
    const result = mergeSavedPaymentsSettings(null, { codEnabled: false });

    expect(result.payments.codEnabled).toBe(false);
    expect(result.theme).toEqual({}); // empty fallback
  });
});
