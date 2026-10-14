import type { RecordAnalysis } from '@wm/core';

/** People, communities, assembled tables and document types; writes analyze/records.json. (Stub: being implemented.) */
export async function analyzeRecords(jobId: string, log: (msg: string) => void = () => {}): Promise<RecordAnalysis> {
  void jobId; void log;
  throw new Error('not implemented');
}
