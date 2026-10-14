import { createBjmProfile } from './bjm.js';
import { createGenericProfile } from './generic.js';
import type { ExtractProfile } from './types.js';

const FACTORIES: Record<string, () => ExtractProfile> = { bjm: createBjmProfile, generic: createGenericProfile };

/** A fresh extraction profile (profiles keep per-job state from prepare()). */
export function createExtractProfile(name: string): ExtractProfile {
  const factory = FACTORIES[name];
  if (!factory) throw new Error(`Unknown platform profile "${name}" (known: ${Object.keys(FACTORIES).join(', ')})`);
  return factory();
}

export type * from './types.js';
