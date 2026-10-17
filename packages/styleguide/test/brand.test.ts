import { expect, it } from 'vitest';
import { BrandFile, brandCss, contrast, contrastChecks, resolveBrand } from '../src/brand.js';

const brand = (theme: Record<string, unknown>, extra: object = {}) =>
  BrandFile.parse({
    schema: 'website-mover/brand@1',
    guide: { title: 'Guide', transcribedBy: 'Tester', transcribedAt: '2026-10-16' },
    tokens: { navy: { value: '#022b58', evidence: 'Colors: Primary' }, green: { value: '#468928', evidence: 'Colors: Secondary' }, big: { value: '48px', evidence: 'H1' } },
    fonts: [{ family: 'Montserrat', weights: [700], evidence: 'Typography' }],
    theme,
    ...extra,
  });

it('computes WCAG contrast ratios', () => {
  expect(contrast('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
  expect(contrast('#FFFFFF', '#468928')).toBeCloseTo(4.31, 2);
  expect(contrast('#767676', '#FFFFFF')).toBeCloseTo(4.54, 2);
});

it('resolves tokens to values with their evidence, and keeps literal values with the reason given', () => {
  const r = resolveBrand(brand({ 'color-primary': 'navy', 'h1-size': 'big', 'h1-case': { value: 'none', why: 'Title case in the guide' }, 'font-heading': '"Montserrat", sans-serif' }));
  expect(r.errors).toEqual([]);
  expect(r.variables).toEqual([
    { name: 'color-primary', value: '#022B58', token: 'navy', evidence: 'Colors: Primary', why: null },
    { name: 'h1-size', value: '48px', token: 'big', evidence: 'H1', why: null },
    { name: 'h1-case', value: 'none', token: null, evidence: null, why: 'Title case in the guide' },
    { name: 'font-heading', value: '"Montserrat", sans-serif', token: null, evidence: null, why: null },
  ]);
  expect(brandCss(r.variables)).toBe(':root {\n  --pw-color-primary: #022B58;\n  --pw-h1-size: 48px;\n  --pw-h1-case: none;\n  --pw-font-heading: "Montserrat", sans-serif;\n}');
});

it('refuses names the theme lacks, unknown tokens, values of the wrong kind, fonts the brand doesn\'t install and anything that could break out of the CSS', () => {
  const r = resolveBrand(
    brand({
      'colour-primary': 'navy',
      'color-text': 'nope',
      'h2-size': 'navy',
      'font-text': '"Comic Sans", sans-serif',
      'color-link': '#000; } body { display: none',
      'button-font': 'x"; }',
      // Not a token, though every object has it.
      'font-heading': 'toString',
    }),
  );
  expect(r.errors).toEqual([
    'theme.colour-primary: the theme has no such variable',
    'theme.color-text: "nope" is neither a token nor a valid color',
    'theme.h2-size: "navy" is neither a token nor a valid length',
    "theme.font-text: Comic Sans isn't one of the brand's fonts",
    'theme.color-link: "#000; } body { display: none" is neither a token nor a valid color',
    'theme.button-font: "x"; }" is neither a token nor a valid font',
    'theme.font-heading: "toString" is neither a token nor a valid font',
  ]);
});

it('checks contrast where the brand sets a colour, following the theme\'s defaults for the other side', () => {
  // Only the button colour is set: its text is the theme's default (#1C1C1C), the footer follows the primary.
  const checks = contrastChecks([{ name: 'color-button', value: '#468928' }, { name: 'color-primary', value: '#022B58' }]);
  expect(checks.find((c) => c.what === 'Buttons')).toMatchObject({ foreground: '#1C1C1C', background: '#468928', passes: false });
  expect(checks.find((c) => c.what === 'Footer text and links')).toMatchObject({ foreground: '#FFFFFF', background: '#022B58', passes: true });
  // Pairs the brand doesn't touch are the theme's own business.
  expect(checks.find((c) => c.what === 'Body text')).toBeUndefined();
  // The system focus colour and a transparent band can't be checked.
  expect(contrastChecks([{ name: 'color-breadcrumb', value: 'transparent' }])).toEqual([]);
});
