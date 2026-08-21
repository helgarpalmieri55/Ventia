import { describe, expect, it } from 'vitest';
import { FOOTER_LINKS } from '../components/site-footer';
import { POLICY_DEFAULTS } from '../lib/policy-defaults';

describe('SiteFooter links', () => {
  it('links every policy page, /privacidad and /terminos-y-condiciones included', () => {
    // Ley 1581 art. 12 / Decreto 1074 art. 2.2.2.25.3.1: the política de
    // tratamiento must be PUT IN THE KNOWLEDGE of the Titular, not merely
    // exist at a URL. Before the footer existed, nothing in the entire
    // storefront linked to any of these pages — the only way to read a
    // store's privacy policy was to guess its path.
    //
    // `/terminos-y-condiciones` is here for the same kind of reason and an
    // even more literal one: Ley 1480 art. 50 lit. d) requires the
    // condiciones generales del contrato to be accessible for consultation,
    // printing and download BEFORE and after the transaction. This footer is
    // the only "before" in the storefront.
    expect(FOOTER_LINKS.map((l) => l.href).sort()).toEqual([
      '/cambios-y-devoluciones',
      '/contacto',
      '/envios',
      '/privacidad',
      '/terminos-y-condiciones',
    ]);
  });

  it('every href is a real page in this app, and every label is non-empty', () => {
    // Guards the failure this test is actually for: a renamed route leaving a
    // dead link where the privacy policy used to be. `POLICY_DEFAULTS` keys
    // are the four content types those pages render, so a route removed from
    // one side and not the other shows up here as a count mismatch.
    expect(FOOTER_LINKS).toHaveLength(Object.keys(POLICY_DEFAULTS).length);
    for (const link of FOOTER_LINKS) {
      expect(link.href.startsWith('/')).toBe(true);
      expect(link.label.trim().length).toBeGreaterThan(0);
    }
  });
});
