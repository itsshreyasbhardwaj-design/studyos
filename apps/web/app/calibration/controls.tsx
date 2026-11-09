'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '../ui.tsx';
import { applyFitAction, clearFitAction } from '../actions.ts';

interface Fit {
  fitted: boolean;
  reason?: string;
  scale: number;
  interval?: [number, number];
  logLossBefore: number;
  logLossAfter: number;
  scored: number;
  lapses: number;
}

interface Stored {
  scale: number;
  fittedFromReviews: number;
  interval?: [number, number];
  updatedAtLabel: string;
}

function durability(scale: number): string {
  const delta = Math.abs(1 - scale) * 100;
  if (scale < 1) return `${delta.toFixed(0)}% less durable than the model assumes`;
  return `${delta.toFixed(0)}% more durable than the model assumes`;
}

export function FitControls({
  fit,
  appliedScale,
  stored,
  currentLogLoss,
}: {
  fit: Fit;
  appliedScale: number;
  stored?: Stored;
  currentLogLoss: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();

  function apply() {
    setError(undefined);
    startTransition(async () => {
      const result = await applyFitAction();
      if (!result.ok) setError(result.reason);
      router.refresh();
    });
  }

  function clear() {
    startTransition(async () => {
      await clearFitAction();
      router.refresh();
    });
  }

  return (
    <Card title="Correction">
      {stored ? (
        <div
          className="mb-4 rounded-lg border p-3"
          style={{ borderColor: 'var(--accent)', background: 'var(--surface-hover)' }}
        >
          <p className="text-sm">
            In force: your memory is treated as{' '}
            <strong className="tabular-nums">{stored.scale.toFixed(2)}×</strong> as durable —{' '}
            {durability(stored.scale)}.
          </p>
          <p className="mt-1 text-xs dim">
            Fitted {stored.updatedAtLabel} from {stored.fittedFromReviews} reviews
            {stored.interval
              ? `, 95% interval ${stored.interval[0].toFixed(2)}–${stored.interval[1].toFixed(2)}`
              : ''}
            . Every modelled recall and every scheduled interval in the app now uses it; the
            measurement above still judges the published model, so you can see what it was fixing.
          </p>
          <p className="mt-1 text-xs dim tabular-nums">
            Log loss under the correction: {currentLogLoss.toFixed(4)}
          </p>
          <button
            type="button"
            onClick={clear}
            disabled={pending}
            className="mt-2 text-xs"
            style={{ color: 'var(--accent)' }}
          >
            {pending ? 'Working…' : 'Go back to the published model'}
          </button>
        </div>
      ) : null}

      {fit.fitted ? (
        <div className="space-y-3">
          <p className="text-sm">
            Your log supports a correction of{' '}
            <strong className="tabular-nums">{fit.scale.toFixed(2)}×</strong> — {durability(fit.scale)}.
          </p>
          <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            <Line
              term="95% interval"
              value={fit.interval ? `${fit.interval[0].toFixed(2)} – ${fit.interval[1].toFixed(2)}` : 'not bounded'}
            />
            <Line term="Fitted from" value={`${fit.scored} reviews, ${fit.lapses} lapses`} />
            <Line term="Log loss before" value={fit.logLossBefore.toFixed(4)} />
            <Line term="Log loss after" value={fit.logLossAfter.toFixed(4)} />
          </dl>
          <p className="text-xs dim">
            Read the interval, not the point estimate. Your review gaps were chosen by the
            uncorrected scheduler, which puts almost every review where it already predicts about
            90% recall — so there is little evidence about what happens elsewhere, and the single
            number is pulled around by that. The interval is what the log can actually rule out.
          </p>
          {appliedScale === 1 || Math.abs(appliedScale - fit.scale) > 0.001 ? (
            <button
              type="button"
              onClick={apply}
              disabled={pending}
              className="rounded-lg px-3 py-1.5 text-sm disabled:opacity-40"
              style={{ background: 'var(--accent)', color: 'var(--bg)' }}
            >
              {pending ? 'Applying…' : stored ? 'Refit from current reviews' : 'Apply this correction'}
            </button>
          ) : (
            <p className="text-xs dim">This is the correction already in force.</p>
          )}
          {error && <p className="text-xs" style={{ color: 'var(--danger, #e5484d)' }}>{error}</p>}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm">No correction — {fit.reason}</p>
          <p className="text-xs dim">
            One number is fitted here, not seventeen: how durable your memory is relative to the
            published model. A few hundred reviews cannot identify seventeen weights, and a
            confident number built on that would be worse than no number at all.
          </p>
          {fit.interval && (
            <p className="text-xs dim tabular-nums">
              Best guess {fit.scale.toFixed(2)}×, 95% interval {fit.interval[0].toFixed(2)}–
              {fit.interval[1].toFixed(2)} — which includes 1.00, so the published model is not
              ruled out.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function Line({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="dim">{term}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
