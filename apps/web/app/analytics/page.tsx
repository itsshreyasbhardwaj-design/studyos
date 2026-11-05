import { loadAnalytics } from '../../lib/queries.ts';
import { Card, Prov, Stat, formatMin } from '../ui.tsx';

export const dynamic = 'force-dynamic';

export default function AnalyticsPage() {
  const d = loadAnalytics();
  const maxMinutes = Math.max(60, ...d.trend.map((p) => p.productiveMinutes));
  const week = d.thisWeek;
  const month = d.thirtyDay;

  const subjectTotals = Object.entries(month.time.bySubject).sort((a, b) => b[1] - a[1]);
  const maxSubject = Math.max(1, ...subjectTotals.map(([, ms]) => ms));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-sm dim mt-1">
          Every figure is arithmetic over stored records. Quiet days are zeros, never interpolated.
        </p>
      </header>

      <Card title="This week">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Productive"
            value={formatMin(Math.round(week.time.productiveMs / 60_000))}
            prov={week.actualMinutes}
          />
          <Stat
            label="Focus ratio"
            value={`${(week.focusRatio.value * 100).toFixed(0)}%`}
            sub="active ÷ recorded"
            prov={week.focusRatio}
          />
          <Stat
            label="Reviews"
            value={`${week.reviewsCompleted}`}
            sub={`${week.questionsAttempted} questions graded`}
          />
          <Stat
            label="Accuracy"
            value={week.practiceAccuracy ? `${(week.practiceAccuracy.value * 100).toFixed(0)}%` : '—'}
            sub={week.practiceAccuracy ? 'graded this week' : 'no graded questions'}
            prov={week.practiceAccuracy}
          />
        </div>
      </Card>

      <Card title="Last 30 days">
        <div
          className="flex h-40 items-end gap-1"
          role="img"
          aria-label={`Daily productive minutes over 30 days, peak ${maxMinutes} minutes`}
        >
          {d.trend.map((p) => {
            const height = (p.productiveMinutes / maxMinutes) * 100;
            return (
              <div
                key={p.window.from}
                className="group relative flex-1"
                style={{ height: '100%', display: 'flex', alignItems: 'flex-end' }}
                title={`${new Date(p.window.from).toLocaleDateString()} · ${formatMin(p.productiveMinutes)}${
                  p.accuracy !== undefined ? ` · ${(p.accuracy * 100).toFixed(0)}% accuracy` : ''
                }`}
              >
                <div
                  className="w-full rounded-t"
                  style={{
                    height: `${Math.max(height, p.productiveMinutes > 0 ? 3 : 1)}%`,
                    background:
                      p.productiveMinutes > 0 ? 'var(--color-accent)' : 'var(--border)',
                    opacity: p.productiveMinutes > 0 ? 0.85 : 1,
                  }}
                />
              </div>
            );
          })}
        </div>
        <div className="mt-3 flex justify-between text-xs dim">
          <span>{new Date(d.trend[0]?.window.from ?? d.now).toLocaleDateString()}</span>
          <span>peak {formatMin(maxMinutes)}</span>
          <span>today</span>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Consistency">
          <div className="grid gap-5 sm:grid-cols-3">
            <Stat
              label="Active days"
              value={`${d.consistency.activeDays}/${d.consistency.totalDays}`}
            />
            <Stat label="Longest streak" value={`${d.consistency.longestStreak}d`} />
            <Stat
              label="Show-up rate"
              value={`${(d.consistency.ratio * 100).toFixed(0)}%`}
            />
          </div>
          <p className="mt-4 text-xs dim">
            Consistency counts days you showed up, not hours piled on. Rest days are not penalised
            and long unbroken sessions are not rewarded.
          </p>
        </Card>

        <Card title="Time by subject (30 days)">
          {subjectTotals.length === 0 ? (
            <p className="text-sm dim">No subject-tagged activity recorded.</p>
          ) : (
            <ul className="space-y-3">
              {subjectTotals.map(([subjectId, ms]) => (
                <li key={subjectId}>
                  <div className="flex justify-between text-sm">
                    <span>{d.subjectNames[subjectId] ?? subjectId}</span>
                    <span className="tabular-nums dim">
                      {formatMin(Math.round(ms / 60_000))}
                    </span>
                  </div>
                  <div
                    className="mt-1 h-1.5 w-full overflow-hidden rounded-full"
                    style={{ background: 'var(--border)' }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${(ms / maxSubject) * 100}%`,
                        background: 'var(--color-accent)',
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Where the time was categorised (30 days)">
        <ul className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
          {Object.entries(month.time.byCategory)
            .sort((a, b) => b[1] - a[1])
            .map(([category, ms]) => (
              <li key={category} className="flex justify-between text-sm">
                <span className="capitalize">{category.replace(/_/g, ' ')}</span>
                <span className="tabular-nums dim">{formatMin(Math.round(ms / 60_000))}</span>
              </li>
            ))}
        </ul>
        {month.time.conflictMs > 0 && (
          <p className="mt-4 flex items-center gap-2 text-xs dim">
            <Prov p="inferred" />
            {Math.round(month.time.conflictMs / 60_000)} min of overlapping device reports were
            attributed to a single source by precedence. The total is still counted once.
          </p>
        )}
      </Card>
    </div>
  );
}
