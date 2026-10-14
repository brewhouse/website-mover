import { expect, it } from 'vitest';
import { statedColors } from '../src/index.js';

// Text as pdftotext lays out a brand guide's colour page.
const GUIDE = `
  PRIMARY COLORS
  Harbor Blue        HEX #0B3D91     RGB 11 61 145     CMYK 100 75 0 20
  Sunrise Gold       Hex: f5a623     R 245 G 166 B 35
  SECONDARY
  White              #fff            rgb(255, 255, 255)
  Not a colour:      RGB 300 20 20   #GGGGGG
`;

it('reads each colour the guide states once, as #RRGGBB, in every notation brand guides use', () => {
  const colors = statedColors(GUIDE);
  expect(colors.map((c) => c.hex)).toEqual(['#0B3D91', '#FFFFFF', '#F5A623']);
  // The words around it, for the model and for review.
  expect(colors[0]!.context).toMatch(/^PRIMARY COLORS Harbor Blue HEX #0B3D91/);
});

it('converts RGB triples, so a guide that only gives RGB still counts as stating the colour', () => {
  expect(statedColors('Accent: R 245 G 166 B 35').map((c) => c.hex)).toEqual(['#F5A623']);
  expect(statedColors('Text rgb(11, 61, 145)').map((c) => c.hex)).toEqual(['#0B3D91']);
  expect(statedColors('RGB 300 20 20')).toEqual([]);
});
