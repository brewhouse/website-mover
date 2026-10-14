import type { StageRun } from '@wm/db';
import { Badge, type Tone } from './ui';

const TONES: Record<StageRun['status'], Tone> = { queued: 'info', running: 'info', done: 'ok', failed: 'bad' };

export function RunStatus({ run }: { run: Pick<StageRun, 'stage' | 'status'> | null }) {
  if (!run) return <Badge>Not started</Badge>;
  return (
    <Badge tone={TONES[run.status]}>
      {run.stage}: {run.status}
    </Badge>
  );
}
