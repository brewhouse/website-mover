import { expect, it } from 'vitest';
import type { PlanDesign } from '@wm/planner';
import { brandCssBlock, brandCssOf, CSS_BEGIN, CSS_END, withoutBrandCss } from '../src/design.js';

const design: PlanDesign = {
  guide: { title: 'Guide', url: null, transcribedBy: 'Tester', transcribedAt: '2026-10-16' },
  variables: [{ name: 'color-primary', value: '#022B58', token: 'navy', evidence: 'Colors', why: null }],
  fonts: [{ family: 'Montserrat', slug: 'montserrat', fontFamily: 'Montserrat, sans-serif', faces: [{ weight: 700, style: 'normal', file: 'fonts/montserrat-700.woff2', sha256: 'x' }, { weight: 500, style: 'normal', file: 'fonts/montserrat-500.woff2', sha256: 'y' }] }],
  logos: { header: null, footer: null, includesName: false, evidence: '' },
  options: {},
  checks: [],
  deviations: [],
};

it('writes @font-face rules for the installed files and the variables, between the tool\'s markers', () => {
  const block = brandCssBlock(design, new Map([['fonts/montserrat-700.woff2', 'https://example.org/wp-content/uploads/fonts/montserrat-700.woff2']]));
  expect(block).toBe(
    [
      CSS_BEGIN,
      '@font-face {\n  font-family: "Montserrat";\n  font-style: normal;\n  font-weight: 700;\n  font-display: swap;\n  src: url("https://example.org/wp-content/uploads/fonts/montserrat-700.woff2") format("woff2");\n}',
      ':root {\n  --pw-color-primary: #022B58;\n}',
      CSS_END,
    ].join('\n'),
  );
});

it('replaces only its own block in the custom CSS, keeping what editors wrote around it', () => {
  const old = `.editor-rule { color: red; }\n\n${CSS_BEGIN}\n:root { --pw-color-primary: #000000; }\n${CSS_END}\n\n.after { margin: 0; }`;
  expect(withoutBrandCss(old)).toBe('.editor-rule { color: red; }\n\n.after { margin: 0; }');
  expect(withoutBrandCss('.only { color: red; }')).toBe('.only { color: red; }');
  expect(withoutBrandCss(`${CSS_BEGIN}\nx\n${CSS_END}`)).toBe('');
  // Rollback puts an earlier job's block back, so it reads the block on its own too.
  expect(brandCssOf(old)).toBe(`${CSS_BEGIN}\n:root { --pw-color-primary: #000000; }\n${CSS_END}`);
  expect(brandCssOf('.only { color: red; }')).toBeNull();
});
