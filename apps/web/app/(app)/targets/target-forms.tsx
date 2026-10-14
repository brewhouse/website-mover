'use client';

import { useActionState } from 'react';
import { Button, Field, inputClass, Notice } from '@/components/ui';
import { addTarget, testTarget, type FormState } from '@/lib/actions';

export function AddTargetForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(addTarget, {});
  const v = state.values ?? {};
  return (
    <form action={action} className="grid gap-4 p-4">
      {state.error && <Notice tone="bad">{state.error}</Notice>}
      {state.ok && <Notice tone="ok">{state.ok}</Notice>}
      <Field label="Name" htmlFor="name" hint="Short, e.g. jha-dev.">
        <input id="name" name="name" required pattern="[a-z0-9][a-z0-9-]*" defaultValue={v.name} className={inputClass} />
      </Field>
      <Field label="Site URL" htmlFor="url">
        <input id="url" name="url" type="url" required placeholder="https://dev-site.pantheonsite.io" defaultValue={v.url} className={inputClass} />
      </Field>
      <Field label="WordPress user" htmlFor="wpUser">
        <input id="wpUser" name="wpUser" required autoComplete="off" defaultValue={v.wpUser} className={inputClass} />
      </Field>
      <Field label="Application Password" htmlFor="appPassword" hint="Users → Profile → Application Passwords. Stored encrypted; never shown again.">
        <input id="appPassword" name="appPassword" type="password" required autoComplete="new-password" className={inputClass} />
      </Field>
      <Button variant="primary" type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save target'}
      </Button>
    </form>
  );
}

export function TestTargetButton({ targetId }: { targetId: number }) {
  const [state, action, pending] = useActionState<FormState, FormData>(testTarget, {});
  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="targetId" value={targetId} />
      <Button size="sm" type="submit" disabled={pending}>
        {pending ? 'Testing…' : 'Test connection'}
      </Button>
      {state.ok && <span className="max-w-xs text-right text-xs text-ok">{state.ok}</span>}
      {state.error && <span className="max-w-xs text-right text-xs text-bad">{state.error}</span>}
    </form>
  );
}
