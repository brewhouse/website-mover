'use client';

import { useState } from 'react';
import { DESIGN_INPUTS, MAX_INPUT_BYTES, type DesignInput } from '@/lib/design-inputs';

/** Uploads one zip as the raw request body (streamed to disk on the server), with progress. */
export function uploadInput(jobId: string, name: DesignInput, file: File, onProgress: (share: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_INPUT_BYTES) return reject(new Error(`${file.name} is over ${MAX_INPUT_BYTES / 1024 / 1024} MB`));
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/jobs/${encodeURIComponent(jobId)}/inputs/${name}`);
    xhr.setRequestHeader('Content-Type', 'application/zip');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`${DESIGN_INPUTS[name]}: ${xhr.responseText || xhr.statusText}`)));
    xhr.onerror = () => reject(new Error(`${DESIGN_INPUTS[name]}: the upload failed (connection)`));
    xhr.send(file);
  });
}

export function ProgressBar({ share, label }: { share: number; label: string }) {
  return (
    <div className="grid gap-1 text-xs">
      <div className="flex justify-between text-muted">
        <span>{label}</span>
        <span className="tabular-nums">{Math.round(share * 100)}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-canvas" role="progressbar" aria-label={label} aria-valuenow={Math.round(share * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full bg-brand transition-[width]" style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
}

/** Replaces one of a job's zips (job page). The next ingest uses it. */
export function ReplaceInput({ jobId, name, present }: { jobId: string; name: DesignInput; present: string | null }) {
  const [share, setShare] = useState<number | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  return (
    <div className="grid gap-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium">{DESIGN_INPUTS[name]}</div>
          <div className="text-xs text-muted">{present ?? 'not uploaded'}</div>
        </div>
        <label className="cursor-pointer rounded-md border border-line bg-panel px-2 py-1 text-xs font-medium hover:bg-canvas">
          {present ? 'Replace' : 'Upload'}
          <input
            type="file"
            accept=".zip,application/zip"
            className="sr-only"
            disabled={share !== null}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setMessage(null);
              setShare(0);
              try {
                await uploadInput(jobId, name, file, setShare);
                setMessage({ tone: 'ok', text: `Uploaded ${file.name}. Run “Ingest → plan” to use it.` });
              } catch (err) {
                setMessage({ tone: 'bad', text: (err as Error).message });
              } finally {
                setShare(null);
                e.target.value = '';
              }
            }}
          />
        </label>
      </div>
      {share !== null && <ProgressBar share={share} label="Uploading" />}
      {message && <div className={`text-xs ${message.tone === 'ok' ? 'text-ok' : 'text-bad'}`}>{message.text}</div>}
    </div>
  );
}
