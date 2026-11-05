'use client';

import { useActionState } from 'react';
import type { JobOptions } from '@wm/db';
import { OptionFields } from '@/components/job-options';
import { Button, inputClass, Notice } from '@/components/ui';
import { rollback, runStages, saveJobOptions, saveLiveUrl, type FormState } from '@/lib/actions';

export interface RunChoice {
  run: string;
  label: string;
  help: string;
  primary?: boolean;
  disabled?: string | false;
}

export function RunButtons({ jobId, choices, busy }: { jobId: string; choices: RunChoice[]; busy: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(runStages, {});
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

/** Where the site lives once launched; the post-launch check runs against it (else the target). */
export function LiveUrlForm({ jobId, liveUrl }: { jobId: string; liveUrl: string | null }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveLiveUrl, {});
  return (
    <form action={action} className="grid gap-2 p-4">
      {state.error && <Notice tone="bad">{state.error}</Notice>}
      {state.ok && <Notice tone="ok">{state.ok}</Notice>}
      <input type="hidden" name="jobId" value={jobId} />
      <label htmlFor="liveUrl" className="text-xs text-muted">
        Once launched, the site’s public address. Post-launch checks run against it.
      </label>
      <div className="flex gap-2">
        <input id="liveUrl" name="liveUrl" type="url" placeholder="https://www.example.org" defaultValue={state.values?.liveUrl ?? liveUrl ?? ''} className={inputClass} />
        <Button size="sm" type="submit" disabled={pending}>
          Save
        </Button>
      </div>
    </form>
  );
}

/** The job's options (incremental, content only, side navigation in the main menu or on pages). */
export function JobOptionsForm({ jobId, options, planned }: { jobId: string; options: JobOptions; planned: JobOptions | null }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveJobOptions, {});
  const differs = planned && (Object.keys(options) as (keyof JobOptions)[]).some((k) => !!options[k] !== !!planned[k]);
  return (
    <form action={action} className="grid gap-3 p-4">
      {state.error && <Notice tone="bad">{state.error}</Notice>}
      {state.ok && <Notice tone="ok">{state.ok}</Notice>}
      {differs && !state.ok && <Notice tone="warn">The latest plan was made with different options: plan again for these to apply.</Notice>}
      <input type="hidden" name="jobId" value={jobId} />
      <OptionFields values={options} />
      <div>
        <Button size="sm" type="submit" disabled={pending}>
          Save options
        </Button>
      </div>
    </form>
  );
}

/** Undoes the job on its target; the job's name must be typed to confirm. */
export function RollbackForm({ jobId, targetName, busy }: { jobId: string; targetName: string; busy: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(rollback, {});
  return (
    <form action={action} className="grid gap-2 p-4 text-sm">
      {state.error && <Notice tone="bad">{state.error}</Notice>}
      {state.ok && <Notice tone="ok">{state.ok}</Notice>}
      <input type="hidden" name="jobId" value={jobId} />
      <p className="text-xs text-muted">
        Removes what this job put on {targetName}: its redirects, pages, posts, events, entries and forms (to the trash), its uploaded files (deleted), and its content types.
        Puts back the menus, theme options, homepage and settings as they were before its first run, and the seed content it trashed.
      </p>
      <label htmlFor="confirm" className="text-xs">
        Type <strong>{jobId}</strong> to confirm.
      </label>
      <div className="flex gap-2">
        <input id="confirm" name="confirm" autoComplete="off" className={inputClass} />
        <Button size="sm" variant="danger" type="submit" disabled={pending || busy}>
          Roll back
        </Button>
      </div>
    </form>
  );
}
