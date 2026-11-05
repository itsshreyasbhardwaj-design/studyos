import { loadReport } from '../../lib/queries.ts';
import { Card, Prov, Stat, formatMin } from '../ui.tsx';

export const dynamic = 'force-dynamic';

export default function ReportPage() {
  const { report, subjectNames, topicNames } = loadReport();
  const m = report.metrics;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Daily Intelligence Report</h1>
        <p className="text-sm dim mt-1">
          {report.date} · {report.headline}
        </p>
      </header>

      <Card title="Measured">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Recorded"
            value={formatMin(m.recordedMinutes.value)}
            sub="all categories"
            prov={m.recordedMinutes}
          />
          <Stat
            label="Active"
            value={formatMin(m.activeMinutes.value)}
            sub="interaction only"
            prov={m.activeMinutes}
          />
          <Stat label="Breaks" value={formatMin(m.breakMinutes)} />
          <Stat label="Distraction" value={formatMin(m.distractionMinutes)} />
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Demonstrated">
          <div className="grid gap-5 sm:grid-cols-2">
            <Stat
              label="Questions graded"
              value={`${m.questionsAttempted}`}
            />
            <Stat
              label="Accuracy"
              value={m.practiceAccuracy ? `${(m.practiceAccuracy.value * 100).toFixed(0)}%` : '—'}
              prov={m.practiceAccuracy}
            />
            <Stat label="Reviews completed" value={`${m.reviewsCompleted}`} />
            <Stat label="Mistakes logged" value={`${m.mistakesLogged}`} />
          </div>
          {!m.practiceAccuracy && (
            <p className="mt-4 text-xs dim">
              No graded questions today, so there is evidence of time spent but none of learning
              achieved. These are reported separately on purpose.
            </p>
          )}
        </Card>

        <Card title="Planned vs actual">
          <div className="grid gap-5 sm:grid-cols-3">
            <Stat label="Planned" value={formatMin(m.plannedVsActual.plannedMinutes)} />
            <Stat label="Actual" value={formatMin(m.plannedVsActual.actualMinutes)} />
            <Stat
              label="Difference"
              value={`${m.plannedVsActual.deltaMinutes >= 0 ? '+' : ''}${m.plannedVsActual.deltaMinutes}m`}
            />
          </div>
          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            <Stat label="Tasks completed" value={`${m.tasksCompleted}`} />
            <Stat label="Still open" value={`${m.tasksOutstanding}`} />
          </div>
        </Card>
      </div>

      {m.bySubjectMinutes.length > 0 && (
        <Card title="By subject">
          <ul className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
            {m.bySubjectMinutes.map((row) => (
              <li key={row.subjectId} className="flex justify-between text-sm">
                <span>{subjectNames[row.subjectId] ?? row.subjectId}</span>
                <span className="tabular-nums dim">{formatMin(row.minutes)}</span>
              </li>
            ))}
          </ul>
          {m.byDeviceMinutes.length > 1 && (
            <p className="mt-4 text-xs dim">
              Devices:{' '}
              {m.byDeviceMinutes
                .map((dv) => `${dv.deviceId} ${formatMin(dv.minutes)}`)
                .join(' · ')}
            </p>
          )}
        </Card>
      )}

      <Card title="What the records say">
        <ul className="space-y-2.5">
          {report.observations.map((o, i) => (
            <li key={i} className="flex gap-2.5 text-sm">
              <span className="dim select-none">—</span>
              <span>{o}</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs dim">
          These are rule outputs over today&apos;s records, not generated prose. No AI model was
          asked to interpret your day; nothing here is invented.
        </p>
      </Card>

      {report.reviseNext.length > 0 && (
        <Card title="Revise next">
          <ul className="space-y-2.5">
            {report.reviseNext.map((r) => (
              <li key={r.topicId} className="text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <span>{topicNames[r.topicId] ?? r.topicId}</span>
                  <span className="shrink-0 text-xs tabular-nums dim">
                    {r.predictedRetention === undefined
                      ? 'not yet reviewed'
                      : `${(r.predictedRetention * 100).toFixed(0)}% recall`}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs dim">
                  <Prov p="inferred" reason="modelled, not observed" />
                  <span>{r.reason}</span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {report.dataQuality.length > 0 && (
        <Card title="Data quality">
          <ul className="space-y-2">
            {report.dataQuality.map((w, i) => (
              <li key={i} className="text-sm" style={{ color: 'var(--color-caution)' }}>
                {w}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs dim">
            Shown so you can correct the record. Corrections are stored as new events; the original
            is kept for audit.
          </p>
        </Card>
      )}

      <Card title="Reflection">
        <ul className="space-y-2">
          {report.reflectionPrompts.map((q) => (
            <li key={q} className="text-sm dim">
              {q}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs dim">
          Optional. Reflections are saved with the focus session they belong to.
        </p>
      </Card>
    </div>
  );
}
