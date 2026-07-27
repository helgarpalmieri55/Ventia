import {
  Bitter,
  Inter,
  Lora,
  Merriweather,
  Montserrat,
  Open_Sans,
  Poppins,
  Raleway,
  Source_Serif_4,
  Work_Sans,
} from 'next/font/google';

/** The fixed 5-pair font catalog (spec §5.4, `@ventia/core`'s `FONT_PAIRS`),
 * loaded via `next/font/google` at build time — all 10 families (5 pairs x
 * 2 fonts each), regardless of any single tenant's choice. `next/font/google`
 * requires its calls at module scope (not conditional/dynamic), which is
 * exactly why this can't just load the one pair a given tenant picked: which
 * pair that is is only known per-request, not at build time. Each font gets
 * its own CSS variable; `lib/theme.ts`'s `fontPairVars` maps a tenant's saved
 * `fontPair` to the two variables (heading/body) that apply for that
 * request, via `--font-heading`/`--font-body`. */
const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const lora = Lora({ subsets: ['latin'], variable: '--font-lora' });
// Poppins has no variable-font axis in next/font/google's catalog, so
// `weight` is mandatory — a small fixed set covering body/heading/bold use.
const poppins = Poppins({ subsets: ['latin'], weight: ['400', '600', '700'], variable: '--font-poppins' });
const sourceSerif4 = Source_Serif_4({ subsets: ['latin'], variable: '--font-source-serif-4' });
const montserrat = Montserrat({ subsets: ['latin'], variable: '--font-montserrat' });
const merriweather = Merriweather({ subsets: ['latin'], variable: '--font-merriweather' });
const raleway = Raleway({ subsets: ['latin'], variable: '--font-raleway' });
const openSans = Open_Sans({ subsets: ['latin'], variable: '--font-open-sans' });
const workSans = Work_Sans({ subsets: ['latin'], variable: '--font-work-sans' });
const bitter = Bitter({ subsets: ['latin'], variable: '--font-bitter' });

/** All 10 fonts' `next/font` `.variable` class names, joined for a single
 * `className` on `<html>` — each class just declares its CSS custom property
 * in scope (e.g. `--font-inter`), it doesn't apply any font by itself, so
 * applying all 10 regardless of the active tenant's pair is harmless: only
 * the two variables `--font-heading`/`--font-body` resolve to actually end
 * up used, per `globals.css`. */
export const fontVariables = [
  inter.variable,
  lora.variable,
  poppins.variable,
  sourceSerif4.variable,
  montserrat.variable,
  merriweather.variable,
  raleway.variable,
  openSans.variable,
  workSans.variable,
  bitter.variable,
].join(' ');
