/**
 * The AI's part of the design plan (PLAN "Flow" 3): it refines the rules' draft proposal. It sees the
 * model (sections, lists, their values with short samples), the target's schema and the Figma frame
 * names, and returns the same Proposal shape. It decides structure only: which post type a list
 * shows, new post types and taxonomies, field names, labels and types. It never writes content;
 * plan.ts checks everything it returns (labels must be in the mockups).
 */
import { structured } from '@wm/llm';
import type { Inventory } from './ingest.js';
import type { DesignModel, Leaf } from './model.js';
import { Proposal } from './propose.js';
import { describeGroups, type TargetSchema } from './schema.js';

const INSTRUCTIONS = `You are planning how a set of HTML mockups becomes a WordPress site built on an existing framework theme with ACF.
You get: the rules' DRAFT proposal, the MODEL of each page (sections, lists, the values they show with short samples), the TARGET's existing post types, taxonomies and ACF field groups, and the Figma frame names.
Return the whole proposal, improved. Keep every page and every part of the draft (same page, path and collection); change only their decisions.
Rules:
- Reuse what the target has: an existing post type or taxonomy whenever one fits; existing ACF field names when a field group on that post type, page template or block already has a field for the value (use its exact name).
- A list of entries that also has a detail page in the mockups (e.g. a gallery of albums and an album page) is a post type: use an existing one or propose a new one (postTypes). Lists of links or repeated decorative items on one page are repeaters (binding "repeater") or block fields, not post types.
- Map list values to WordPress fields where they belong: the entry's title, excerpt, featured image, date, terms (core). Use ACF fields (core null) only for values WordPress doesn't have.
- Section headings on single entry templates ("Overview", "Staff") are the template's own words: leave them out of fields.
- Labels must be words that appear in the mockups (their text, the Figma layer and frame names, or class names). Never invent wording. Field names are lower_snake_case.
- Post type names: lower_snake_case, at most 20 characters. Taxonomy names: at most 32.
- Never write or rewrite content. Samples are for understanding only.`;

const trim = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);
const leafLine = (l: Leaf) => `${l.path} [${l.kind}] ${l.label}${l.sample ? `: "${trim(l.sample)}"` : ''}`;

export async function refineProposal(input: { model: DesignModel; schema: TargetSchema; draft: Proposal; frames: Inventory['frames']; log?: (m: string) => void }): Promise<Proposal> {
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL) throw new Error('OPENAI_API_KEY and OPENAI_MODEL must be set in .env for --ai');
  const { model, schema, draft } = input;
  const modelText = model.pages
    .map((p) =>
      [
        `PAGE ${p.file} (frames: ${p.frames.map((f) => input.frames.find((x) => x.id === f)?.name ?? f).join(', ') || 'none'})`,
        ...p.sections.flatMap((s) => [
          `  SECTION ${s.component} path="${s.path}"${s.heading ? ` heading="${s.heading}"` : ''}`,
          ...s.leaves.filter((l) => l.kind !== 'icon').map((l) => `    ${leafLine(l)}`),
          ...s.collections.flatMap((c) => [`    LIST ${c.role} collection="${c.path}" ${c.count}× ${c.item}`, ...c.leaves.filter((l) => l.kind !== 'icon').map((l) => `      ${leafLine(l)}`)]),
        ]),
      ].join('\n'),
    )
    .join('\n');
  const schemaText = [
    'POST TYPES: ' + Object.entries(schema.post_types).map(([n, t]) => `${n} (${t.label}; taxonomies ${t.taxonomies.join(', ') || 'none'})`).join('; '),
    'TAXONOMIES: ' + Object.entries(schema.taxonomies).map(([n, t]) => `${n} (${t.label}) on ${t.object_type.join(', ')}`).join('; '),
    'FIELD GROUPS:',
    ...describeGroups(schema.acf?.field_groups ?? []).map((g, i) => {
      const loc = schema.acf!.field_groups[i]!.location.map((a) => a.map((r) => `${r.param}==${r.value}`).join(' & ')).join(' | ');
      return `  ${g} (shown where ${loc})`;
    }),
  ].join('\n');

  const result = await structured({
    schema: Proposal,
    name: 'design_proposal',
    instructions: INSTRUCTIONS,
    reasoning: 'medium',
    input: [
      { type: 'text', text: `MODEL\n${modelText}` },
      { type: 'text', text: `TARGET\n${schemaText}` },
      { type: 'text', text: `DRAFT\n${JSON.stringify(draft)}` },
    ],
  });
  input.log?.(`AI: ${result.parts.length} parts, ${result.postTypes.length} new post types, ${result.taxonomies.length} new taxonomies proposed`);
  return result;
}
