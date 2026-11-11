'use client';

import { useActionState } from 'react';
import { Button, Notice } from '@/components/ui';
import type { FormState } from '@/lib/actions';
import { approveDesign, runDesignStages } from '@/lib/design-actions';

export function DesignApproveForm({ jobId, version, sha256, disabled }: { jobId: string; version: number; sha256: string; disabled?: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(approveDesign, {});
  return (
    <form action={action} className="grid gap-3">
      {state.error && <Notice tone="bad">{state.error}</Notice>}
      {state.ok && <Notice tone="ok">{state.ok}</Notice>}
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="sha256" value={sha256} />
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="reviewed" className="mt-0.5" disabled={!!disabled} />
        <span>I reviewed design plan v{version}: the templates, content types, fields, blocks, menus and sample content.</span>
      </label>
      <div className="flex items-center gap-3">
        <Button variant="primary" type="submit" disabled={pending || !!disabled}>
          {pending ? 'Approving…' : `Approve design plan v${version}`}
        </Button>
        {disabled && <span className="text-xs text-muted">{disabled}</span>}
      </div>
    </form>
  );
}

export function DesignReplanButton({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(runDesignStages, {});
  return (
    <form action={action} className="flex items-center gap-3">
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="run" value="plan" />
      <Button size="sm" variant="primary" type="submit" disabled={pending}>
        {pending ? 'Queuing…' : 'Re-plan with these changes'}
      </Button>
      {state.error && <span className="text-xs text-bad">{state.error}</span>}
      {state.ok && <span className="text-xs text-ok">Queued. The new version appears on the job page when it’s ready.</span>}
    </form>
  );
}
