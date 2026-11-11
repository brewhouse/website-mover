'use client';

import { useActionState } from 'react';
import { Button, Notice } from '@/components/ui';
import type { FormState } from '@/lib/actions';
import { runDesignStages } from '@/lib/design-actions';
import type { RunChoice } from './run-buttons';

export function DesignRunButtons({ jobId, choices, busy }: { jobId: string; choices: RunChoice[]; busy: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(runDesignStages, {});
  return (
    <div className="grid gap-3 p-4">
      {state.error && <Notice tone="bad">{state.error}</Notice>}
      {state.ok && <Notice tone="ok">{state.ok}</Notice>}
      {choices.map((c) => (
        <form key={c.run} action={action} className="flex items-start justify-between gap-4">
          <input type="hidden" name="jobId" value={jobId} />
          <input type="hidden" name="run" value={c.run} />
          <div className="min-w-0 text-sm">
            <div className="font-medium">{c.label}</div>
            <div className="text-xs text-muted">{c.disabled || c.help}</div>
          </div>
          <Button size="sm" variant={c.primary ? 'primary' : 'secondary'} type="submit" disabled={pending || busy || !!c.disabled}>
            Run
          </Button>
        </form>
      ))}
    </div>
  );
}
