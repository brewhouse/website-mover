/**
 * The plan's Design section on the target (docs/m3/branding.md): the logos (media library, `site_logo`
 * and the theme's footer logo option), the fonts (installed through the Font Library, so they're
 * self-hosted and editors see them) and the brand's CSS: @font-face rules and the theme's variables,
 * in Global Styles custom CSS. That lives in the database, so it works on Pantheon test and live,
 * where the theme's files can't be written. The tool owns one marked block in that CSS; anything an
 * editor adds outside it stays.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { jobPath } from '@wm/core';
import type { Plan, PlanDesign, PlanLogo } from '@wm/planner';
import { brandCss } from '@wm/styleguide/brand';
import type { WpClient } from '@wm/wp-client';

export const CSS_BEGIN = '/* Website Mover brand: begin. Set from the approved plan; edits between these lines are replaced on the next run. */';
export const CSS_END = '/* Website Mover brand: end */';

/** What the design step did (run state). */
export interface DesignState {
  logos: { header: number | null; footer: number | null };
  /** Font family slug → its Font Library ID. */
  fonts: Record<string, number>;
  css: boolean;
  options: Record<string, string>;
  warnings: string[];
}

/** The tool's block in custom CSS, or null. */
export function brandCssOf(css: string): string | null {
  const start = css.indexOf(CSS_BEGIN);
  const end = css.indexOf(CSS_END);
  return start >= 0 && end > start ? css.slice(start, end + CSS_END.length) : null;
}

/** Custom CSS without the tool's block. */
export function withoutBrandCss(css: string): string {
  const start = css.indexOf(CSS_BEGIN);
  const end = css.indexOf(CSS_END);
  if (start < 0 || end < start) return css;
  return (css.slice(0, start).trimEnd() + '\n\n' + css.slice(end + CSS_END.length).trimStart()).trim();
}

/** The tool's block: @font-face rules for the installed font files, then the theme's variables. */
export function brandCssBlock(design: PlanDesign, fontUrls: Map<string, string>): string {
  const faces = design.fonts.flatMap((f) =>
    f.faces.flatMap((face) => {
      const url = fontUrls.get(face.file);
      if (!url) return [];
      return [`@font-face {\n  font-family: "${f.family}";\n  font-style: ${face.style};\n  font-weight: ${face.weight};\n  font-display: swap;\n  src: url("${url}") format("woff2");\n}`];
    }),
  );
  return [CSS_BEGIN, ...faces, brandCss(design.variables), CSS_END].join('\n');
}

/** A Font Library URL safe to put in url("…"). */
const SAFE_URL = /^https?:\/\/[^\s"'()\\<>]+$/;

/** The active theme's Global Styles post (Appearance → Editor → Styles). */
export async function userGlobalStyles(client: WpClient): Promise<{ id: number; styles: Record<string, unknown> }> {
  const [theme] = await client.get<{ _links?: Record<string, { href: string }[]> }[]>('/wp/v2/themes', { status: 'active' });
  const href = theme?._links?.['wp:user-global-styles']?.[0]?.href;
  const id = Number(href?.split('/').pop());
  if (!id) throw new Error('The active theme has no Global Styles (it needs to be a block theme or have theme.json)');
  const post = await client.get<{ styles?: Record<string, unknown> | unknown[] }>(`/wp/v2/global-styles/${id}`, { context: 'edit' });
  return { id, styles: Array.isArray(post.styles) ? {} : (post.styles ?? {}) };
}

export async function applyDesign(
  client: WpClient,
  plan: Plan,
  ctx: {
    jobId: string;
    /** Uploads a logo (or finds the one an earlier run uploaded) and returns its attachment ID. */
    upload: (logo: PlanLogo, key: string, filename: string) => Promise<number>;
    fail: (step: string, err: unknown) => void;
    log: (msg: string) => void;
  },
): Promise<DesignState> {
  const design = plan.design!;
  const state: DesignState = { logos: { header: null, footer: null }, fonts: {}, css: false, options: {}, warnings: [] };
  const attempt = async (step: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      ctx.fail(step, err);
    }
  };

  // Logos. The key carries the file's hash: a new logo is a new upload, a re-run reuses the old one.
  for (const role of ['header', 'footer'] as const) {
    const logo = design.logos[role];
    if (!logo) continue;
    await attempt(`${role} logo`, async () => {
      state.logos[role] = await ctx.upload(logo, `design:logo-${role}:${logo.sha256.slice(0, 12)}`, logo.file.split('/').pop()!);
    });
  }
  await attempt('site logo', async () => {
    if (state.logos.header) await client.post('/wp/v2/settings', { site_logo: state.logos.header });
  });
  // Fonts: reuse a family or face that's already installed, install the rest.
  const fontUrls = new Map<string, string>();
  for (const font of design.fonts) {
    await attempt(`font ${font.family}`, async () => {
      const found = await findFontFamily(client, font.slug);
      const familyId =
        found?.id ??
        (await client.post<{ id: number }>('/wp/v2/font-families', { font_family_settings: JSON.stringify({ name: font.family, slug: font.slug, fontFamily: font.fontFamily }) })).id;
      state.fonts[font.slug] = familyId;
      const installed = await fontFaces(client, familyId);
      for (const face of font.faces) {
        let url = installed.find((f) => f.font_face_settings.fontStyle === face.style && String(f.font_face_settings.fontWeight) === String(face.weight))?.font_face_settings.src;
        if (!url) {
          const data = await verified(ctx.jobId, face.file, face.sha256);
          const form = new FormData();
          form.append('font_face_settings', JSON.stringify({ fontFamily: font.fontFamily, fontStyle: face.style, fontWeight: String(face.weight), src: 'file-0' }));
          form.append('file-0', new Blob([data], { type: 'font/woff2' }), face.file.split('/').pop()!);
          url = (await client.postForm<FontFace>(`/wp/v2/font-families/${familyId}/font-faces`, form)).font_face_settings.src;
        }
        const src = [url].flat()[0];
        if (src && SAFE_URL.test(src)) fontUrls.set(face.file, src);
        else state.warnings.push(`${font.family} ${face.weight} ${face.style}: the Font Library gave no usable file URL: not in the CSS.`);
      }
    });
  }

  await attempt('brand CSS', async () => {
    const gs = await userGlobalStyles(client);
    const css = [withoutBrandCss(String(gs.styles.css ?? '')), brandCssBlock(design, fontUrls)].filter(Boolean).join('\n\n');
    await client.post(`/wp/v2/global-styles/${gs.id}`, { styles: { ...gs.styles, css } });
    state.css = true;
  });

  // Theme options last, and only where what they depend on worked: the header hides the site name
  // only next to the brand's logo, and the theme's Google fonts go only once the brand's are in the CSS.
  const options: Record<string, string | number> = { ...design.options };
  if (!state.logos.header) delete options.header_show_site_name;
  const allFonts = design.fonts.every((f) => f.faces.every((face) => fontUrls.has(face.file)));
  if (!state.css || !allFonts) delete options.theme_google_fonts;
  if (state.logos.footer) options.site_footer_logo = state.logos.footer;
  await attempt('theme options', async () => {
    if (!Object.keys(options).length) return;
    state.options = await client.post<Record<string, string>>('/website-mover/v1/acf/options', { values: options });
    const unknown = Object.keys(state.options).filter((k) => state.options[k] === 'unknown field');
    if (unknown.length) state.warnings.push(`The theme has no option ${unknown.map((k) => `"${k}"`).join(', ')} (theme patches T1, T19, T21): not set.`);
  });

  ctx.log(`Design: ${design.variables.length} theme variables, ${fontUrls.size} font files, logos ${[state.logos.header && 'header', state.logos.footer && 'footer'].filter(Boolean).join(' and ') || 'none'}`);
  for (const w of state.warnings) ctx.log(`  ! ${w}`);
  return state;
}

/**
 * An installed font family by slug. The Font Library's list ignores a `slug` filter (WordPress 7.0),
 * so this matches on the family's settings.
 */
export async function findFontFamily(client: WpClient, slug: string): Promise<{ id: number } | undefined> {
  const families = await allPages<{ id: number; font_family_settings: { slug: string } }>(client, '/wp/v2/font-families');
  return families.find((f) => f.font_family_settings.slug === slug);
}

async function allPages<T>(client: WpClient, route: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const batch = await client.get<T[]>(route, { per_page: 100, page });
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

type FontFace = { id: number; parent: number; font_face_settings: { fontStyle: string; fontWeight: string | number; src: string | string[] } };

/** A font family's faces. The faces list returns every family's faces (WordPress 7.0): keep this family's. */
export async function fontFaces(client: WpClient, familyId: number): Promise<FontFace[]> {
  return (await allPages<FontFace>(client, `/wp/v2/font-families/${familyId}/font-faces`)).filter((f) => f.parent === familyId);
}

/** A brand file's bytes, refused if they aren't the ones the plan was approved with. */
export async function verified(jobId: string, file: string, sha256: string): Promise<Uint8Array<ArrayBuffer>> {
  const data = new Uint8Array(await readFile(jobPath(jobId, 'inputs', 'brand', file)));
  if (createHash('sha256').update(data).digest('hex') !== sha256) throw new Error(`${file} changed after this plan was made: run "wm plan" and approve again`);
  return data;
}
