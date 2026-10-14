'use client';

import { useActionState } from 'react';
import { Button, Field, inputClass, Notice } from '@/components/ui';
import { login, type FormState } from '@/lib/actions';

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(login, {});
  return (
    <form action={action} className="grid gap-4 rounded-lg border border-line bg-panel p-6">
      {state.error && <Notice tone="bad">{state.error}</Notice>}
      <input type="hidden" name="next" value={next} />
      <Field label="Email" htmlFor="email">
        <input id="email" name="email" type="email" autoComplete="username" required className={inputClass} />
      </Field>
      <Field label="Password" htmlFor="password">
        <input id="password" name="password" type="password" autoComplete="current-password" required className={inputClass} />
      </Field>
      <Button variant="primary" type="submit" disabled={pending}>
        {pending ? 'Logging in…' : 'Log in'}
      </Button>
      <p className="text-xs text-muted">Accounts are created by an administrator (wm user add).</p>
    </form>
  );
}
