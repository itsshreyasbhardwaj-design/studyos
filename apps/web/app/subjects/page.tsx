import { loadSubjects } from '../../lib/queries.ts';
import { Card, Empty, MASTERY_TONE, Prov, formatMin } from '../ui.tsx';
import { MASTERY_LABELS } from '@studyos/core';

export const dynamic = 'force-dynamic';

export default function SubjectsPage() {
  const d = loadSubjects();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Subjects</h1>
        <p className="text-sm dim mt-1">
          Mastery is derived from graded performance and modelled retention only. Study hours are
          shown beside it and deliberately do not feed into it.
        </p>
      </header>

      {d.subjects.length === 0 && (
        <Card>
          <Empty title="No subjects yet" />
        </Card>
      )}

      {d.subjects.map((s) => {
        const counts = s.topics.reduce<Record<string, number>>((acc, t) => {
          acc[t.assessment.state] = (acc[t.assessment.state] ?? 0) + 1;
          return acc;
        }, {});

        return (
          <Card
            key={s.id}
            title={`${s.name}${s.level ? ` · ${s.level}` : ''}`}
            action={
              <span className="text-xs dim tabular-nums">
                {formatMin(s.thirtyDayMinutes)} recorded in 30 days
              </span>
            }
          >
            <div className="mb-4 flex flex-wrap gap-2">
              {Object.entries(counts).map(([state, n]) => (
                <span
                  key={state}
                  className="rounded-full border px-2.5 py-0.5 text-xs"
                  style={{ borderColor: MASTERY_TONE[state], color: MASTERY_TONE[state] }}
                >
                  {n} {MASTERY_LABELS[state as keyof typeof MASTERY_LABELS].toLowerCase()}
                </span>
              ))}
            </div>

            <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {s.topics.map((t) => (
                <li key={t.id} className="py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm">{t.name}</span>
                    <span
                      className="text-xs font-medium"
                      style={{ color: MASTERY_TONE[t.assessment.state] }}
                    >
                      {MASTERY_LABELS[t.assessment.state]}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs dim">
                    {t.assessment.accuracy !== undefined && (
                      <>
                        <Prov p="demonstrated" reason="graded practice attempts" />
                        <span>
                          {(t.assessment.accuracy * 100).toFixed(0)}% over{' '}
                          {t.assessment.attemptCount} attempts
                        </span>
                      </>
                    )}
                    {t.assessment.predictedRetention !== undefined && (
                      <>
                        <Prov p="inferred" reason="FSRS forgetting curve" />
                        <span>
                          {(t.assessment.predictedRetention * 100).toFixed(0)}% modelled recall
                        </span>
                      </>
                    )}
                    {t.assessment.attemptCount === 0 &&
                      t.assessment.predictedRetention === undefined && (
                        <span>no evidence recorded yet</span>
                      )}
                  </div>
                  <div className="mt-1 text-xs" style={{ color: 'var(--text-dim)' }}>
                    Next: {t.assessment.nextStep}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}
