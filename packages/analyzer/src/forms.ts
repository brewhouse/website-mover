import type { FormAnalysis } from '@wm/core';

/** Extracts web forms as plugin-neutral specs; writes analyze/forms.json. (Stub: being implemented.) */
export async function analyzeForms(jobId: string, log: (msg: string) => void = () => {}): Promise<FormAnalysis> {
  void jobId; void log;
  throw new Error('not implemented');
}
