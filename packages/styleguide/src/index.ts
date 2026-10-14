/**
 * Style guide PDF → design tokens (PLAN §6.8): deterministic facts first, then the model assigns
 * roles, then a cross-check keeps only colours the PDF actually states.
 */
import path from 'node:path';
import { z } from 'zod';
import { structured } from '@wm/llm';
import { normalizeHex, readPdfFacts, type PdfFacts } from './deterministic.js';

export { readPdfFacts, normalizeHex, type PdfFacts };

const Role = z.enum(['primary', 'secondary', 'accent', 'text', 'background', 'other']);

/** What the model is asked for. Every value must be visible in the PDF. */
const ModelOutput = z.object({
  colors: z.array(
    z.object({
      role: Role,
      hex: z.string().describe('The colour as #RRGGBB, exactly as stated in the guide (convert RGB triples; never estimate from images).'),
      name: z.string().nullable().describe('The colour name used in the guide, if any.'),
      evidence: z.string().describe('The words in the guide that state this colour and its use.'),
    }),
  ),
  headingFont: z.object({ family: z.string(), evidence: z.string() }).nullable(),
  bodyFont: z.object({ family: z.string(), evidence: z.string() }).nullable(),
  logo: z.object({ page: z.number().int(), description: z.string() }).nullable(),
});

export interface StyleGuideResult {
  /** Accepted colours by role (first accepted colour per role). */
  palette: Partial<Record<z.infer<typeof Role>, { hex: string; name: string | null; evidence: string }>>;
  colors: { role: string; hex: string; name: string | null; evidence: string; accepted: boolean; reason: string }[];
  headingFont: { family: string; evidence: string; inPdf: boolean } | null;
  bodyFont: { family: string; evidence: string; inPdf: boolean } | null;
  logo: { page: number; description: string; candidates: string[] } | null;
  facts: Omit<PdfFacts, 'text'>;
}

export async function extractStyleGuide(pdf: string, workDir: string): Promise<StyleGuideResult> {
  const facts = await readPdfFacts(pdf, workDir);
  const stated = new Map(facts.colors.map((c) => [c.hex, c]));

  const output = await structured({
    schema: ModelOutput,
    name: 'style_guide',
    instructions: [
      'You read brand style guides. Report the colours the guide states, with the role the guide gives each',
      '(primary, secondary, accent, text, background, or other), the heading and body font families, and the page that shows the main logo.',
      'Only report values the guide states in words or numbers. Never estimate a colour from an image. If the guide does not say, return null or omit it.',
      `Colour values found in the guide's text: ${facts.colors.map((c) => c.hex).join(', ') || 'none'}. Fonts embedded in the PDF: ${facts.fonts.join(', ') || 'none'}.`,
    ].join(' '),
    input: [{ type: 'pdf', path: pdf }, ...facts.renders.slice(0, 6).map((p) => ({ type: 'image' as const, path: p, mime: 'image/png' as const }))],
    reasoning: 'medium',
  });

  // Cross-check: a colour is kept only if the PDF's own text states it.
  const colors = output.colors.map((c) => {
    const hex = normalizeHex(c.hex);
    const accepted = !!hex && stated.has(hex);
    return { role: c.role, hex: hex ?? c.hex, name: c.name, evidence: c.evidence, accepted, reason: accepted ? 'stated in the PDF' : 'not found in the PDF text: rejected' };
  });
  const palette: StyleGuideResult['palette'] = {};
  for (const c of colors) if (c.accepted && !palette[c.role as keyof typeof palette]) palette[c.role as keyof typeof palette] = { hex: c.hex, name: c.name, evidence: c.evidence };

  const fontInPdf = (family: string) => facts.fonts.some((f) => f.toLowerCase().replace(/[^a-z]/g, '').includes(family.toLowerCase().replace(/[^a-z]/g, ''))) || facts.text.toLowerCase().includes(family.toLowerCase());
  const { text: _text, ...rest } = facts;
  void _text;
  return {
    palette,
    colors,
    headingFont: output.headingFont ? { ...output.headingFont, inPdf: fontInPdf(output.headingFont.family) } : null,
    bodyFont: output.bodyFont ? { ...output.bodyFont, inPdf: fontInPdf(output.bodyFont.family) } : null,
    logo: output.logo ? { ...output.logo, candidates: facts.images.filter((i) => i.page === output.logo!.page).map((i) => path.relative(workDir, i.file)) } : null,
    facts: rest,
  };
}
