import type { MeetingAnalysis } from '@wm/core';

/** Groups meeting pages into meetings; writes analyze/meetings.json. (Stub: being implemented.) */
export async function analyzeMeetings(jobId: string, log: (msg: string) => void = () => {}): Promise<MeetingAnalysis> {
  void jobId; void log;
  throw new Error('not implemented');
}
