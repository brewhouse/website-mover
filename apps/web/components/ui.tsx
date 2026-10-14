import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

const BUTTON = {
  primary: 'bg-brand text-brand-ink hover:bg-brand/90 border-brand',
  secondary: 'bg-panel text-ink hover:bg-canvas border-line',
  danger: 'bg-panel text-bad hover:bg-bad-soft border-line',
  ghost: 'bg-transparent text-brand hover:bg-info-soft border-transparent',
} as const;

const SIZE = { md: 'px-3.5 py-2 text-sm', sm: 'px-2 py-1 text-xs' } as const;

export function Button({ variant = 'secondary', size = 'md', className, ...props }: ComponentProps<'button'> & { variant?: keyof typeof BUTTON; size?: keyof typeof SIZE }) {
  return (
    <button
      {...props}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
        BUTTON[variant],
        SIZE[size],
        className,
      )}
    />
  );
}

export function LinkButton({ variant = 'secondary', size = 'md', className, ...props }: ComponentProps<typeof Link> & { variant?: keyof typeof BUTTON; size?: keyof typeof SIZE }) {
  return (
    <Link
      {...props}
      className={cx('inline-flex items-center gap-1.5 rounded-md border font-medium whitespace-nowrap transition-colors', BUTTON[variant], SIZE[size], className)}
    />
  );
}

const TONE = {
  neutral: 'bg-canvas text-muted border-line',
  ok: 'bg-ok-soft text-ok border-ok/20',
  warn: 'bg-warn-soft text-warn border-warn/20',
  bad: 'bg-bad-soft text-bad border-bad/20',
  info: 'bg-info-soft text-brand border-brand/20',
} as const;
export type Tone = keyof typeof TONE;

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', TONE[tone])}>
      {children}
    </span>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-lg border border-line bg-panel', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor: string }) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

export const inputClass =
  'w-full rounded-md border border-line bg-panel px-3 py-2 text-sm placeholder:text-muted/70 focus:border-brand focus:outline-2 focus:outline-brand/30';

export function Notice({ tone = 'info', children }: { tone?: Tone; children: ReactNode }) {
  return <div className={cx('rounded-md border px-4 py-3 text-sm', TONE[tone])}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-center text-sm text-muted">{children}</p>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-3">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function when(date: Date | string | null | undefined): string {
  if (!date) return '—';
  return new Date(date).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}
