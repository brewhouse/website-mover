/**
 * Brand files (docs/m3/branding.md): a style guide's values, transcribed by a person, for guides the
 * PDF pipeline can't read (a Figma prototype has no text to cross-check against). Every value names
 * where the guide states it; the plan's Design section shows them, so approval checks them.
 *
 * The file has two parts: the guide's own values (`tokens`, `fonts`, `logos`), and how they fill the
 * theme's CSS variables (`theme`), which is a design decision about the theme's layout, not something
 * the guide states. The tool checks the result against WCAG 2.1 AA contrast.
 */
import { z } from 'zod';

export const BRAND_SCHEMA = 'website-mover/brand@1';

const Hex = /^#[0-9A-Fa-f]{6}$/;

/** A value the guide states, and where it states it. */
const Token = z.object({ value: z.string().min(1), evidence: z.string().min(1) });

/** A theme variable's value: a token name or a CSS value, with why when it isn't the guide's obvious choice. */
const ThemeValue = z.union([z.string().min(1), z.object({ value: z.string().min(1), why: z.string().min(1) })]);

export const BrandFile = z.object({
  schema: z.literal(BRAND_SCHEMA),
  guide: z.object({
    title: z.string().min(1),
    url: z.string().url().optional(),
    /** Who transcribed the values, and when. The plan's approver checks them against the guide. */
    transcribedBy: z.string().min(1),
    transcribedAt: z.string().min(1),
  }),
  /** The guide's values by name ("primary", "darkGreen"): colours as #RRGGBB, sizes as CSS lengths. */
  tokens: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/, 'a token name: letters and digits'), Token),
  /** Fonts to install (self-hosted from WordPress's Google Fonts collection). */
  fonts: z
    .array(
      z.object({
        family: z.string().regex(/^[A-Za-z0-9 ]+$/, 'a font family name'),
        weights: z.array(z.number().int().min(100).max(900)).min(1),
        italic: z.boolean().default(false),
        evidence: z.string().min(1),
      }),
    )
    .default([]),
  /** The theme's CSS variables, without "--pw-" (THEME_VARIABLES). */
  theme: z.record(z.string(), ThemeValue),
  /** Logo files, relative to the brand file. */
  logos: z
    .object({
      header: z.string().nullable(),
      footer: z.string().nullable(),
      /** The logo shows the organization's name, so the header doesn't repeat it as text. */
      includesName: z.boolean(),
      evidence: z.string().min(1),
    })
    .nullable()
    .default(null),
  /** Where the site knowingly differs from the guide, and why (e.g. contrast). */
  deviations: z.array(z.object({ what: z.string(), guide: z.string(), site: z.string(), why: z.string() })).default([]),
});
export type BrandFile = z.infer<typeof BrandFile>;

type Kind = 'color' | 'font' | 'length' | 'case' | 'weight';

/**
 * PlaneteriaWeb's CSS variables (theme patches T5, T17–T21) and their defaults: a colour or value, or
 * `@name` for another variable's value.
 */
export const THEME_VARIABLES: Record<string, { kind: Kind; label: string; default: string }> = {
  'font-heading': { kind: 'font', label: 'Headings, menus', default: '"Ubuntu", sans-serif' },
  'font-text': { kind: 'font', label: 'Body text', default: '"Open Sans", sans-serif' },
  'color-primary': { kind: 'color', label: 'Primary: menus, header top bar (right), title accents', default: '#202188' },
  'color-primary-dark': { kind: 'color', label: 'Dark primary', default: '#160B50' },
  'color-secondary': { kind: 'color', label: 'Secondary: accents, rules', default: '#327136' },
  'color-secondary-strong': { kind: 'color', label: 'Secondary where text needs contrast (green text on white, white text on green)', default: '@color-secondary' },
  'color-accent': { kind: 'color', label: 'Accent: event date boxes, carousel arrows', default: '#F0AB2B' },
  'color-text': { kind: 'color', label: 'Body text', default: '#1C1C1C' },
  'color-muted': { kind: 'color', label: 'Muted text, borders', default: '#9D9D9D' },
  'color-surface': { kind: 'color', label: 'Light backgrounds', default: '#EFEFF0' },
  'color-link': { kind: 'color', label: 'Links', default: '#327136' },
  'color-link-hover': { kind: 'color', label: 'Links on hover', default: '#202188' },
  'color-heading': { kind: 'color', label: 'Headings H1–H3, page titles', default: '#1C1C1C' },
  'color-heading-minor': { kind: 'color', label: 'Headings H4–H6', default: '#1C1C1C' },
  'color-button': { kind: 'color', label: 'Buttons', default: '#F0AB2B' },
  'color-button-text': { kind: 'color', label: 'Button text', default: '#1C1C1C' },
  'color-button-hover': { kind: 'color', label: 'Buttons on hover', default: '#327136' },
  'color-button-hover-text': { kind: 'color', label: 'Button text on hover', default: '#FFFFFF' },
  'color-on-dark-hover': { kind: 'color', label: 'Footer links on hover', default: '#F0AB2B' },
  'color-header-utility': { kind: 'color', label: 'Header top bar, left (phone, utility links)', default: '@color-secondary' },
  'color-nav-hover': { kind: 'color', label: 'Main menu item on hover', default: '@color-primary' },
  'color-nav-current': { kind: 'color', label: 'Main menu: the current section', default: '@color-secondary' },
  'color-breadcrumb': { kind: 'color', label: 'Breadcrumb band', default: 'transparent' },
  'color-alert': { kind: 'color', label: 'Alert bar (white text)', default: '@color-accent' },
  'color-focus': { kind: 'color', label: 'Keyboard focus outline', default: 'Highlight' },
  'color-input-border': { kind: 'color', label: 'Form field borders', default: '#000000' },
  'color-footer': { kind: 'color', label: 'Footer (white text)', default: '@color-primary' },
  'color-footer-bottom': { kind: 'color', label: 'Footer bottom bar (white text)', default: '@color-primary-dark' },
  'color-footer-band': { kind: 'color', label: 'Footer links band', default: '@color-surface' },
  'color-footer-band-link': { kind: 'color', label: 'Footer links band: links', default: '@color-link' },
  'color-footer-band-link-hover': { kind: 'color', label: 'Footer links band: links on hover', default: '@color-link-hover' },
  'color-footer-rule': { kind: 'color', label: 'Footer lines', default: '@color-secondary' },
  'text-size': { kind: 'length', label: 'Body text size', default: '15px' },
  'text-line-height': { kind: 'length', label: 'Body text line height', default: '25px' },
  'h1-size': { kind: 'length', label: 'H1', default: '48px' },
  'h2-size': { kind: 'length', label: 'H2', default: '38px' },
  'h3-size': { kind: 'length', label: 'H3', default: '26px' },
  'h4-size': { kind: 'length', label: 'H4', default: '22px' },
  'h5-size': { kind: 'length', label: 'H5', default: '19px' },
  'h6-size': { kind: 'length', label: 'H6', default: '16px' },
  'h1-case': { kind: 'case', label: 'H1 and page title letter case', default: 'uppercase' },
  'breadcrumb-case': { kind: 'case', label: 'Breadcrumb letter case', default: 'uppercase' },
  'button-font': { kind: 'font', label: 'Button font', default: 'inherit' },
  'button-size': { kind: 'length', label: 'Button text size', default: '18px' },
  'button-weight': { kind: 'weight', label: 'Button text weight', default: '700' },
  'button-radius': { kind: 'length', label: 'Button corners', default: '50px' },
};

/** A theme variable the brand sets. */
export interface BrandVariable {
  /** Without "--pw-". */
  name: string;
  value: string;
  /** The token it comes from, if any, and where the guide states it. */
  token: string | null;
  evidence: string | null;
  /** Why this value, when the brand file says. */
  why: string | null;
}

/** A WCAG 2.1 contrast check on the colours the brand sets. */
export interface ContrastCheck {
  what: string;
  foreground: string;
  background: string;
  ratio: number;
  /** 4.5 for text, 3 for large text and for focus outlines and field borders. */
  needs: number;
  passes: boolean;
}

export interface ResolvedBrand {
  variables: BrandVariable[];
  checks: ContrastCheck[];
  /** Problems that make the brand file unusable (unknown variables or tokens, invalid values). */
  errors: string[];
}

const FONT_STACK = /^(?:"[A-Za-z0-9 ]+"|[a-z-]+)(?:,\s*(?:"[A-Za-z0-9 ]+"|[a-z-]+))*$/;
const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace', 'system-ui', 'cursive', 'inherit']);

function validValue(kind: Kind, value: string): boolean {
  switch (kind) {
    case 'color':
      return Hex.test(value) || value === 'transparent';
    case 'font':
      return FONT_STACK.test(value);
    case 'length':
      return value === '0' || /^\d+(?:\.\d+)?(?:px|rem|em)$/.test(value);
    case 'case':
      return ['none', 'uppercase', 'lowercase', 'capitalize'].includes(value);
    case 'weight':
      return /^[1-9]00$/.test(value) || value === 'normal' || value === 'bold';
  }
}

/** The brand's theme variables, checked: every name is the theme's, every token exists, every value fits. */
export function resolveBrand(brand: BrandFile): ResolvedBrand {
  const errors: string[] = [];
  const variables: BrandVariable[] = [];
  const families = new Set(brand.fonts.map((f) => f.family));
  for (const [name, entry] of Object.entries(brand.theme)) {
    const spec = THEME_VARIABLES[name];
    if (!spec) {
      errors.push(`theme.${name}: the theme has no such variable`);
      continue;
    }
    const raw = typeof entry === 'string' ? entry : entry.value;
    const token = Object.hasOwn(brand.tokens, raw) ? brand.tokens[raw] : undefined;
    const value = token ? token.value : raw;
    if (spec.kind === 'color' && token && !Hex.test(value)) {
      errors.push(`theme.${name}: token "${raw}" is ${value}, not a #RRGGBB colour`);
      continue;
    }
    if (!validValue(spec.kind, value)) {
      errors.push(`theme.${name}: "${raw}" is neither a token nor a valid ${spec.kind}`);
      continue;
    }
    if (spec.kind === 'font') {
      const first = value.split(',')[0]!.trim().replace(/^"|"$/g, '');
      if (!GENERIC_FONTS.has(first) && !families.has(first)) errors.push(`theme.${name}: ${first} isn't one of the brand's fonts`);
    }
    variables.push({
      name,
      value: Hex.test(value) ? value.toUpperCase() : value,
      token: token ? raw : null,
      evidence: token?.evidence ?? null,
      why: typeof entry === 'string' ? null : entry.why,
    });
  }
  for (const [name, t] of Object.entries(brand.tokens)) {
    if (t.value.startsWith('#') && !Hex.test(t.value)) errors.push(`tokens.${name}: ${t.value} isn't #RRGGBB`);
  }
  return { variables, checks: errors.length ? [] : contrastChecks(variables), errors };
}

/** The `:root` rule that sets the brand's variables (Global Styles custom CSS). */
export function brandCss(variables: Pick<BrandVariable, 'name' | 'value'>[]): string {
  return `:root {\n${variables.map((v) => `  --pw-${v.name}: ${v.value};`).join('\n')}\n}`;
}

const WHITE = '#FFFFFF';

/**
 * Where the theme puts text or outlines on a colour the brand may set. Sizes decide the threshold:
 * bold text from 18.66px (14pt) and any text from 24px is large (3:1).
 */
const PAIRS: { what: string; fg: string; bg: string; needs: number }[] = [
  { what: 'Body text', fg: 'color-text', bg: WHITE, needs: 4.5 },
  { what: 'Headings H1–H3 (bold, 24px and up)', fg: 'color-heading', bg: WHITE, needs: 3 },
  { what: 'Headings H4–H6', fg: 'color-heading-minor', bg: WHITE, needs: 4.5 },
  { what: 'Links', fg: 'color-link', bg: WHITE, needs: 4.5 },
  { what: 'Links on hover', fg: 'color-link-hover', bg: WHITE, needs: 4.5 },
  { what: 'Secondary-colour text (e.g. "View All News")', fg: 'color-secondary-strong', bg: WHITE, needs: 4.5 },
  { what: 'White text on the secondary colour (homepage shortcuts on hover)', fg: WHITE, bg: 'color-secondary-strong', needs: 4.5 },
  { what: 'Buttons', fg: 'color-button-text', bg: 'color-button', needs: 4.5 },
  { what: 'Buttons on hover', fg: 'color-button-hover-text', bg: 'color-button-hover', needs: 4.5 },
  { what: 'Header top bar, left', fg: WHITE, bg: 'color-header-utility', needs: 4.5 },
  { what: 'Header top bar, right', fg: WHITE, bg: 'color-primary', needs: 4.5 },
  { what: 'Main menu', fg: 'color-primary', bg: WHITE, needs: 4.5 },
  { what: 'Main menu on hover', fg: 'color-nav-hover', bg: WHITE, needs: 4.5 },
  { what: 'Main menu: current section', fg: 'color-nav-current', bg: WHITE, needs: 4.5 },
  { what: 'Breadcrumb', fg: 'color-text', bg: 'color-breadcrumb', needs: 4.5 },
  { what: 'Alert bar (bold 21px)', fg: WHITE, bg: 'color-alert', needs: 3 },
  { what: 'Footer links band', fg: 'color-footer-band-link', bg: 'color-footer-band', needs: 4.5 },
  { what: 'Footer links band on hover', fg: 'color-footer-band-link-hover', bg: 'color-footer-band', needs: 4.5 },
  { what: 'Footer links band heading (28px)', fg: 'color-heading', bg: 'color-footer-band', needs: 3 },
  { what: 'Footer text and links', fg: WHITE, bg: 'color-footer', needs: 4.5 },
  { what: 'Footer links on hover', fg: 'color-on-dark-hover', bg: 'color-footer', needs: 4.5 },
  { what: 'Footer bottom bar', fg: WHITE, bg: 'color-footer-bottom', needs: 4.5 },
  { what: 'Footer bottom bar links on hover', fg: 'color-on-dark-hover', bg: 'color-footer-bottom', needs: 4.5 },
  { what: 'Keyboard focus outline', fg: 'color-focus', bg: WHITE, needs: 3 },
  { what: 'Form field borders', fg: 'color-input-border', bg: WHITE, needs: 3 },
];

/** Checks the pairs where the brand sets at least one of the colours; the rest are the theme's own. */
export function contrastChecks(variables: Pick<BrandVariable, 'name' | 'value'>[]): ContrastCheck[] {
  const set = new Map(variables.map((v) => [v.name, v.value]));
  const value = (name: string, seen = new Set<string>()): string => {
    if (name.startsWith('#')) return name;
    if (set.has(name)) return set.get(name)!;
    const d = THEME_VARIABLES[name]?.default ?? '';
    if (d.startsWith('@') && !seen.has(name)) return value(d.slice(1), seen.add(name));
    return d;
  };
  // A variable counts as set when the brand sets it or the variable it defaults to.
  const fromBrand = (name: string): boolean => {
    const d = THEME_VARIABLES[name]?.default ?? '';
    return set.has(name) || (d.startsWith('@') && fromBrand(d.slice(1)));
  };
  const checks: ContrastCheck[] = [];
  for (const p of PAIRS) {
    if (!fromBrand(p.fg) && !fromBrand(p.bg)) continue;
    const fg = value(p.fg);
    const bg = value(p.bg);
    if (!Hex.test(fg) || !Hex.test(bg)) continue; // transparent, the system highlight
    const ratio = contrast(fg, bg);
    checks.push({ what: p.what, foreground: fg.toUpperCase(), background: bg.toUpperCase(), ratio: Math.floor(ratio * 100) / 100, needs: p.needs, passes: ratio >= p.needs });
  }
  return checks;
}

/** WCAG 2.1 contrast ratio of two #RRGGBB colours. */
export function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** What `wm brand` copied into a job (inputs/brand/manifest.json). */
export interface BrandLogo {
  /** Relative to inputs/brand. */
  file: string;
  sha256: string;
  contentType: string;
  width: number | null;
  height: number | null;
}

export interface BrandFontFace {
  weight: number;
  style: 'normal' | 'italic';
  /** Relative to inputs/brand. */
  file: string;
  sha256: string;
  sourceUrl: string;
}

export interface BrandFont {
  family: string;
  slug: string;
  /** The CSS font-family value WordPress's collection gives (e.g. `Montserrat, sans-serif`). */
  fontFamily: string;
  faces: BrandFontFace[];
}

export interface BrandManifest {
  importedAt: string;
  /** sha256 of brand.json. */
  brandSha256: string;
  logos: { header: BrandLogo | null; footer: BrandLogo | null };
  fonts: BrandFont[];
}
