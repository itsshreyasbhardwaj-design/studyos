import { loadCalibration } from '../../lib/queries.ts';
import { Card, Empty, Prov, formatDay } from '../ui.tsx';
import { FitControls } from './controls.tsx';

export const dynamic = 'force-dynamic';

const VERDICT: Record<string, { label: string; tone: string; detail: string }> = {
  overconfident: {
    label: 'Overconfident',
    tone: 'var(--warn, #e8a33d)',
    detail:
      'You forget faster than the published model expects, so it schedules you later than it should.',
  },
  underconfident: {
    label: 'Underconfident',
    tone: 'var(--warn, #e8a33d)',
    detail:
      'Your memory holds better than the published model expects, so it brings cards back sooner than it needs to.',
  },
  indistinguishable: {
    label: 'No detectable bias',
    tone: 'var(--ok, #3fb950)',
    detail:
      'Predicted and observed recall differ by less than the noise in your sample. The published model describes you as well as this log can tell.',
  },
  insufficient: {
    label: 'Not enough reviews',
    tone: 'var(--text-dim)',
    detail: 'The measurement is shown, but the sample is too small to conclude anything from it.',
  },
};

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export default function CalibrationPage() {
  const d = loadCalibration();
  const c = d.published;
  const verdict = VERDICT[c.verdict];

  if (c.scored === 0) {
    return (
      <div className="space-y-6">
        <Header />
        <Card>
          <Empty
            title="Nothing to check yet"
            hint="This page compares what the scheduler predicted against what happened. It needs reviews with at least a day between them."
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Header />

      <Card
        title="Verdict"
        action={
          <span className="text-xs dim tabular-nums">
            over {c.scored} scored review{c.scored === 1 ? '' : 's'}
          </span>
        }
      >
        <p className="text-lg font-medium" style={{ color: verdict.tone }}>
          {verdict.label}
        </p>
        <p className="mt-1 text-sm dim">{verdict.detail}</p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Figure
            label="Predicted recall"
            value={pct(c.meanPredicted)}
            note="what the model expected, averaged over every scored review"
            prov="inferred"
          />
          <Figure
            label="Observed recall"
            value={`${pct(c.meanObserved)} ± ${pct(2 * c.standardError)}`}
            note={`${c.scored - c.lapses} recalled, ${c.lapses} forgotten`}
            prov="measured"
          />
        </div>

        <dl className="mt-4 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          <Row term="Log loss" value={c.logLoss.toFixed(4)} hint="lower is better" />
          <Row term="Brier score" value={c.brier.toFixed(4)} hint="lower is better" />
        </dl>

        <p className="mt-4 text-xs dim">
          {c.excluded.firstReview} first review
          {c.excluded.firstReview === 1 ? '' : 's'} excluded — there was no prior state to predict
          from. {c.excluded.sameDay} same-day repeat
          {c.excluded.sameDay === 1 ? '' : 's'} excluded — FSRS-4.5 models the long-term trace only,
          so scoring those would flatter it with predictions it never really made.
        </p>
      </Card>

      <Card
        title="Where the model is wrong"
        action={<span className="text-xs dim">grouped by what it predicted</span>}
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs dim">
              <th className="pb-2 font-normal">Predicted band</th>
              <th className="pb-2 text-right font-normal">Reviews</th>
              <th className="pb-2 text-right font-normal">Predicted</th>
              <th className="pb-2 text-right font-normal">Observed</th>
              <th className="pb-2 text-right font-normal">Gap</th>
            </tr>
          </thead>
          <tbody className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {c.buckets.map((b) => {
              const gap = b.predicted - b.observed;
              const thin = b.count < 10;
              return (
                <tr key={b.from}>
                  <td className="py-2 tabular-nums">
                    {pct(b.from)} – {pct(b.to)}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {b.count}
                    {thin && <span className="dim"> ·</span>}
                  </td>
                  <td className="py-2 text-right tabular-nums">{pct(b.predicted)}</td>
                  <td className="py-2 text-right tabular-nums">{pct(b.observed)}</td>
                  <td
                    className="py-2 text-right tabular-nums"
                    style={{ color: Math.abs(gap) > 0.05 ? 'var(--warn, #e8a33d)' : undefined }}
                  >
                    {gap > 0 ? '+' : ''}
                    {pct(gap)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {c.buckets.some((b) => b.count < 10) && (
          <p className="mt-3 text-xs dim">
            · marks a band with fewer than ten reviews in it. Read those rows as anecdote.
          </p>
        )}
        <p className="mt-3 text-xs dim">
          A positive gap means the model expected more recall than it got. Bands are narrow at the
          top because that is where the scheduler puts almost every review — it aims for 90%.
        </p>
      </Card>

      <FitControls
        fit={{
          fitted: d.fit.fitted,
          reason: d.fit.reason,
          scale: d.fit.scale,
          interval: d.fit.interval,
          logLossBefore: d.fit.logLossBefore,
          logLossAfter: d.fit.logLossAfter,
          scored: d.fit.scored,
          lapses: d.fit.lapses,
        }}
        appliedScale={d.appliedScale}
        stored={
          d.stored
            ? {
                scale: d.stored.scale,
                fittedFromReviews: d.stored.fittedFromReviews,
                interval: d.stored.interval,
                updatedAtLabel: formatDay(d.stored.updatedAt),
              }
            : undefined
        }
        currentLogLoss={d.current.logLoss}
      />
    </div>
  );
}

function Header() {
  return (
    <header>
      <h1 className="text-2xl font-semibold tracking-tight">Model check</h1>
      <p className="text-sm dim mt-1">
        Every modelled recall in this app comes from FSRS weights fitted to a large population, not
        to you. This page replays your own review log and reports how far off they are — and
        corrects them only as far as the log can justify.
      </p>
    </header>
  );
}

function Figure({
  label,
  value,
  note,
  prov,
}: {
  label: string;
  value: string;
  note: string;
  prov: 'measured' | 'inferred';
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-xs dim">{label}</span>
        <Prov p={prov} reason={note} />
      </div>
      <p className="mt-0.5 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs dim">{note}</p>
    </div>
  );
}

function Row({ term, value, hint }: { term: string; value: string; hint: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="dim">
        {term} <span className="opacity-70">({hint})</span>
      </dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
