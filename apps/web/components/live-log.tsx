'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

interface Line {
  id: number;
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

const COLORS = { info: 'text-ink', warn: 'text-warn', error: 'text-bad' };

/** The job's log, live: lines stream in, and the page refreshes when a stage starts or ends. */
export function LiveLog({ jobId, initial }: { jobId: string; initial: Line[] }) {
  const [lines, setLines] = useState<Line[]>(initial);
  const [connected, setConnected] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const router = useRouter();

  useEffect(() => {
    const after = initial.at(-1)?.id ?? 0;
    const source = new EventSource(`/api/jobs/${jobId}/events?after=${after}`);
    let lastRun: string | null = null;
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener('log', (e) => {
      const line = JSON.parse((e as MessageEvent).data) as Line;
      setLines((prev) => (prev.some((l) => l.id === line.id) ? prev : [...prev.slice(-1999), line]));
    });
    source.addEventListener('run', (e) => {
      const data = (e as MessageEvent).data;
      if (lastRun !== null && data !== lastRun) router.refresh();
      lastRun = data;
    });
    return () => source.close();
  }, [jobId, initial, router]);

  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);

  return (
    <div>
      <div className="flex items-center justify-between border-b border-line px-4 py-2 text-xs text-muted">
        <span>{lines.length ? `${lines.length} lines` : 'Nothing logged yet'}</span>
        <span className="flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-ok' : 'bg-line'}`} aria-hidden />
          {connected ? 'Live' : 'Connecting…'}
        </span>
      </div>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="h-96 overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed"
        role="log"
        aria-live="polite"
      >
        {lines.map((l) => (
          <div key={l.id} className={`whitespace-pre-wrap ${COLORS[l.level]}`}>
            <span className="text-muted">{new Date(l.at).toLocaleTimeString('en-US', { hour12: false })} </span>
            {l.message}
          </div>
        ))}
      </div>
    </div>
  );
}
