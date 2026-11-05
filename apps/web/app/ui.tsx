import type { ReactNode } from 'react';
import type { Provenance, Provenanced } from '@studyos/core';

const PROV_LABEL: Record<Provenance, string> = {
  measured: 'measured',
  inferred: 'estimated',
  confirmed: 'you confirmed',
  demonstrated: 'demonstrated',
};

/**
 * The provenance chip. Rendering a modelled number without one of these is the
 * single easiest way to break the product's central promise, so every stat
 * component below takes a Provenanced value rather than a bare number.
 */
export function Prov({ p, reason }: { p: Provenance; reason?: string }) {
  return (
    <span className={`prov prov-${p}`} title={reason}>
      {PROV_LABEL[p]}
    </span>
  );
}

export function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card p-5 ${className}`}>
      {(title || action) && (
        <header className="mb-4 flex items-baseline justify-between gap-3">
          {title && <h2 className="text-sm font-medium tracking-wide uppercase dim">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  prov,
}: {
  label: string;
  value: string;
  sub?: string;
  prov?: Provenanced<unknown>;
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-xs dim uppercase tracking-wide">{label}</span>
        {prov && <Prov p={prov.provenance} reason={prov.reason} />}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs dim mt-0.5">{sub}</div>}
    </div>
  );
}

export function Bar({
  value,
  max,
  tone = 'accent',
}: {
  value: number;
  max: number;
  tone?: 'accent' | 'positive' | 'caution' | 'danger';
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const colour = {
    accent: 'var(--color-accent)',
    positive: 'var(--color-positive)',
    caution: 'var(--color-caution)',
    danger: 'var(--color-danger)',
  }[tone];
  return (
    <div
      className="h-1.5 w-full rounded-full overflow-hidden"
      style={{ background: 'var(--border)' }}
      role="presentation"
    >
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: colour }} />
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="py-8 text-center">
      <p className="text-sm">{title}</p>
      {hint && <p className="text-xs dim mt-1">{hint}</p>}
    </div>
  );
}

export function formatMin(min: number): string {
  if (min <= 0) return '0m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDay(ts: number): string {
  return new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

export function relativeDays(ts: number, now: number): string {
  const days = Math.round((ts - now) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days}d` : `${Math.abs(days)}d ago`;
}

export const MASTERY_TONE: Record<string, string> = {
  not_started: 'var(--text-dim)',
  learning: 'var(--color-caution)',
  practising: 'var(--color-accent)',
  needs_revision: 'var(--color-danger)',
  strong: 'var(--color-positive)',
  mastered: 'var(--color-positive)',
};
