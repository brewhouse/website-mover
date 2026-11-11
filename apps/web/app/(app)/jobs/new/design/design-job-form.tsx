'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ProgressBar, uploadInput } from '@/components/design-upload';
import { Button, Field, inputClass, Notice } from '@/components/ui';
import { createDesignJob, startDesignJob } from '@/lib/design-actions';
import type { DesignInput } from '@/lib/design-inputs';

/**
 * Three steps in one submit: create the job, upload both zips (streamed, with progress), then queue
 * ingest → model → plan. If an upload fails, the job exists and its page lets you upload again.
 */
export function DesignJobForm({ targets }: { targets: { id: number; label: string }[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Partial<Record<DesignInput, number>>>({});

  async function submit(form: FormData) {
    setError(null);
    const mockups = form.get('mockups');
    const theme = form.get('theme');
    if (!(mockups instanceof File) || !mockups.size || !(theme instanceof File) || !theme.size) return setError('Choose both zips.');
    setBusy(true);
    // Files stay out of the server action; they go up separately below.
    const fields = new FormData();
    for (const k of ['id', 'figma', 'targetId', 'rights']) if (form.get(k) !== null) fields.set(k, form.get(k) as string);
    const created = await createDesignJob({}, fields);
    if (created.error) {
      setBusy(false);
      return setError(created.error);
    }
    const jobId = created.ok!;
    try {
      for (const [name, file] of [['mockups.zip', mockups], ['theme.zip', theme]] as const) {
        await uploadInput(jobId, name, file, (share) => setProgress((p) => ({ ...p, [name]: share })));
      }
      const started = await startDesignJob(jobId);
      if (started.error) throw new Error(started.error);
      router.push(`/jobs/${jobId}`);
    } catch (err) {
      setBusy(false);
      setError(`${(err as Error).message}. The job ${jobId} was created: upload the zips again from its page.`);
    }
  }

  return (
    <form action={submit} className="grid max-w-2xl gap-5 rounded-lg border border-line bg-panel p-6">
      {error && <Notice tone="bad">{error}</Notice>}
      <Field label="Job name" htmlFor="id" hint="Lowercase letters, numbers and dashes. Used in file paths and URLs.">
        <input id="id" name="id" required pattern="[a-z0-9][a-z0-9-]*" placeholder="newport" className={inputClass} />
      </Field>
      <Field label="Figma link" htmlFor="figma" hint="The page holding the frames: open it in Figma and copy the link (it has ?node-id=…).">
        <input id="figma" name="figma" type="url" required placeholder="https://www.figma.com/design/…?node-id=8173-34" className={inputClass} />
      </Field>
      <Field label="Target" htmlFor="targetId" hint="The seed site: its post types and fields are reused where they fit.">
        <select id="targetId" name="targetId" className={inputClass} required>
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Mockups (zip)" htmlFor="mockups" hint="The HTML/CSS pages with their images. .git folders and SCSS sources are left out on unpacking.">
        <input id="mockups" name="mockups" type="file" accept=".zip,application/zip" required className="text-sm" />
      </Field>
      <Field label="Framework theme (zip)" htmlFor="theme" hint="The site’s planeteriaweb folder (or the whole repo): its templates and blocks are matched to the mockups. Only PHP and JSON files are kept.">
        <input id="theme" name="theme" type="file" accept=".zip,application/zip" required className="text-sm" />
      </Field>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="rights" required className="mt-0.5" />
        <span>These designs are for this client’s site, and we may use their text and images as sample content.</span>
      </label>
      {busy && (
        <div className="grid gap-2">
          <ProgressBar share={progress['mockups.zip'] ?? 0} label="Mockups" />
          <ProgressBar share={progress['theme.zip'] ?? 0} label="Theme" />
        </div>
      )}
      <div>
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? 'Uploading…' : 'Create job and plan'}
        </Button>
      </div>
    </form>
  );
}
