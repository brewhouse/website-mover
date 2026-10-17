import { resolveBrand, type BrandFile, type BrandManifest } from '@wm/styleguide/brand';
import type { PlanDesign } from './schema.js';

/** A brand imported into the job with `wm brand` (inputs/brand). */
export interface BrandInput {
  file: BrandFile;
  manifest: BrandManifest;
  /** sha256 of manifest.json. */
  sha256: string;
}

/** The plan's Design section, and a warning for each colour pair that fails WCAG 2.1 AA. */
export function planDesign({ file, manifest }: BrandInput): { design: PlanDesign; warnings: string[] } {
  const { variables, checks, errors } = resolveBrand(file);
  // `wm brand` refuses such a file; a hand-edited inputs/brand/brand.json would land here.
  if (errors.length) throw new Error(`The job's brand file has problems (run "wm brand" again):\n  ${errors.join('\n  ')}`);
  const header = manifest.logos.header;
  return {
    design: {
      guide: { title: file.guide.title, url: file.guide.url ?? null, transcribedBy: file.guide.transcribedBy, transcribedAt: file.guide.transcribedAt },
      variables,
      fonts: manifest.fonts.map((f) => ({ family: f.family, slug: f.slug, fontFamily: f.fontFamily, faces: f.faces.map(({ weight, style, file, sha256 }) => ({ weight, style, file, sha256 })) })),
      logos: { header, footer: manifest.logos.footer, includesName: file.logos?.includesName ?? false, evidence: file.logos?.evidence ?? '' },
      options: {
        // The header shows the site name next to the logo (theme change T1) unless the logo has it.
        ...(header && file.logos?.includesName ? { header_show_site_name: 0 } : {}),
        // The theme's own fonts from Google (T21) aren't needed once the brand installs fonts and sets
        // both roles; otherwise the role it leaves alone still uses one of them.
        ...(manifest.fonts.length && ['font-heading', 'font-text'].every((n) => variables.some((v) => v.name === n)) ? { theme_google_fonts: 0 } : {}),
      },
      checks,
      deviations: file.deviations,
    },
    warnings: checks.filter((c) => !c.passes).map((c) => `Design: ${c.what}: ${c.foreground} on ${c.background} is ${c.ratio}:1; WCAG 2.1 AA needs ${c.needs}:1.`),
  };
}
