/**
 * The project's one door to the model (PLAN §7): `structured(schema, input)` asks the OpenAI
 * Responses API for output that must match a Zod schema (strict Structured Outputs).
 *
 * Rules for callers (CLAUDE.md): the model judges and extracts; it never writes or rewrites
 * content, and every value it extracts must be checked against the source before use.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { z } from 'zod';

export type InputPart =
  | { type: 'text'; text: string }
  | { type: 'pdf'; path: string }
  | { type: 'image'; path: string; mime: 'image/png' | 'image/jpeg' };

export interface StructuredOptions<S extends z.ZodType> {
  schema: S;
  /** Schema name shown to the model. */
  name: string;
  instructions: string;
  input: InputPart[];
  /** Defaults to OPENAI_MODEL. */
  model?: string;
  reasoning?: 'low' | 'medium' | 'high';
}

export async function structured<S extends z.ZodType>(opts: StructuredOptions<S>): Promise<z.infer<S>> {
  const model = opts.model ?? process.env.OPENAI_MODEL;
  if (!model) throw new Error('OPENAI_MODEL is not set');
  const client = new OpenAI(); // OPENAI_API_KEY from the environment
  const content = await Promise.all(opts.input.map(toContent));
  const response = await client.responses.parse({
    model,
    instructions: opts.instructions,
    input: [{ role: 'user', content }],
    text: { format: zodTextFormat(opts.schema, opts.name) },
    ...(opts.reasoning ? { reasoning: { effort: opts.reasoning } } : {}),
  });
  if (response.output_parsed == null) throw new Error(`The model returned no ${opts.name} (status ${response.status})`);
  return response.output_parsed as z.infer<S>;
}

async function toContent(part: InputPart) {
  switch (part.type) {
    case 'text':
      return { type: 'input_text' as const, text: part.text };
    case 'pdf':
      return {
        type: 'input_file' as const,
        filename: path.basename(part.path),
        file_data: `data:application/pdf;base64,${(await readFile(part.path)).toString('base64')}`,
      };
    case 'image':
      return { type: 'input_image' as const, image_url: `data:${part.mime};base64,${(await readFile(part.path)).toString('base64')}`, detail: 'high' as const };
  }
}
