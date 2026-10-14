'use client';

import { useActionState } from 'react';
import { Button, Notice } from '@/components/ui';
import { approve, runStages, type FormState } from '@/lib/actions';

export function ApproveForm({ jobId, version, sha256, disabled }: { jobId: string; version: number; sha256: string; disabled?: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(approve, {});
  return (
    <form action={action} className="grid gap-3">
      {state.error && <Notice tone="bad">{state.error}</Notice>}
      {state.ok && <Notice tone="ok">{state.ok}</Notice>}
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="sha256" value={sha256} />
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="reviewed" className="mt-0.5" disabled={!!disabled} />
        <span>I reviewed plan v{version}: what’s migrated, where it goes, what’s left out and what’s trashed on the target.</span>
      </label>
      <div className="flex items-center gap-3">
        <Button variant="primary" type="submit" disabled={pending || !!disabled}>
          {pending ? 'Approving…' : `Approve plan v${version}`}
        </Button>
        {disabled && <span className="text-xs text-muted">{disabled}</span>}
      </div>
    </form>
  );
}

export function ReplanButton({ jobId, label = 'Re-plan with these changes' }: { jobId: string; label?: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(runStages, {});
  return (
    <form action={action} className="flex items-center gap-3">
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="run" value="plan" />
      <Button size="sm" variant="primary" type="submit" disabled={pending}>
        {pending ? 'Queuing…' : label}
      </Button>
      {state.error && <span className="text-xs text-bad">{state.error}</span>}
      {state.ok && <span className="text-xs text-ok">Queued. The new version appears on the job page when it’s ready.</span>}
    </form>
  );
}
