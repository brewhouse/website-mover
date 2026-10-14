'use client';

import { useActionState } from 'react';
import { Button, Field, inputClass, Notice } from '@/components/ui';
import { createJobAction, type FormState } from '@/lib/actions';

export function NewJobForm({ targets, timezones }: { targets: { id: number; label: string }[]; timezones: string[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createJobAction, {});
  // After a failed submit React resets the form; these defaults put back what was typed.
  const v = state.values ?? {};
  return (
    <form action={action} className="grid max-w-2xl gap-5 rounded-lg border border-line bg-panel p-6">
      {state.error && <Notice tone="bad">{state.error}</Notice>}
      <Field label="Job name" htmlFor="id" hint="Lowercase letters, numbers and dashes. Used in file paths and URLs.">
        <input id="id" name="id" required pattern="[a-z0-9][a-z0-9-]*" placeholder="jha" defaultValue={v.id} className={inputClass} />
      </Field>
      <Field label="Source site" htmlFor="sourceUrl" hint="The site to copy. It’s crawled politely: robots.txt, sitemaps and links.">
        <input id="sourceUrl" name="sourceUrl" type="url" required placeholder="https://www.example.org" defaultValue={v.sourceUrl} className={inputClass} />
      </Field>
      <Field label="Site profile" htmlFor="profile" hint="The platform the source runs on, if the tool knows it.">
        <select id="profile" name="profile" className={inputClass} defaultValue={v.profile ?? 'generic'}>
          <option value="generic">Generic HTML site</option>
          <option value="bjm">Brooks Jeffrey Marketing CMS (e.g. jaxha.org)</option>
        </select>
      </Field>
      <Field label="Target" htmlFor="targetId">
        <select id="targetId" name="targetId" className={inputClass} defaultValue={v.targetId} required>
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Timezone" htmlFor="timezone" hint="The organization’s local time, for events.">
          <input id="timezone" name="timezone" list="timezones" placeholder="America/New_York" defaultValue={v.timezone} className={inputClass} />
          <datalist id="timezones">
            {timezones.map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
        </Field>
        <Field label="GA4 measurement ID" htmlFor="ga4Id" hint="Optional.">
          <input id="ga4Id" name="ga4Id" placeholder="G-XXXXXXXXXX" defaultValue={v.ga4Id} className={inputClass} />
        </Field>
      </div>
      <Field label="Style guide PDF" htmlFor="styleGuide" hint="Optional now; colours, fonts and logo come from it (up to 50 MB).">
        <input id="styleGuide" name="styleGuide" type="file" accept="application/pdf" className="text-sm" />
      </Field>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="rights" required defaultChecked={v.rights === 'on'} className="mt-0.5" />
        <span>We have the client’s permission to copy this site’s content into the target.</span>
      </label>
      <div>
        <Button variant="primary" type="submit" disabled={pending}>
          {pending ? 'Starting…' : 'Create job and scan'}
        </Button>
      </div>
    </form>
  );
}
