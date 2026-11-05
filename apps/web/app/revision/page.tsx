import { loadRevision } from '../../lib/queries.ts';
import { Bar, Card, Empty, Prov, formatDay } from '../ui.tsx';
import { Reviewer } from './reviewer.tsx';

export const dynamic = 'force-dynamic';

export default function RevisionPage() {
  const d = loadRevision();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Revision</h1>
        <p className="text-sm dim mt-1">
          Scheduled by FSRS-4.5 over {d.totalCards} cards. Intervals are computed from modelled
          memory stability, not fixed reminders.
        </p>
      </header>

      {d.queue.cards.length === 0 ? (
        <Card>
          <Empty
            title="Nothing due"
            hint="Cards reappear when their modelled recall decays toward 90%."
          />
        </Card>
      ) : (
        <Reviewer cards={d.queue.cards} />
      )}

      {d.queue.backlogCount > 0 && (
        <Card title="Backlog">
          <p className="text-sm">
            {d.queue.backlogCount} cards are due beyond this session&apos;s 20-card cap, about{' '}
            {d.queue.backlogSessions} sessions to clear.
          </p>
          <p className="mt-2 text-xs dim">
            The queue is capped on purpose. Serving every overdue card at once is how people
            abandon a review habit; the most at-risk and exam-relevant cards come first.
          </p>
        </Card>
      )}

      <Card title="Forgetfulness radar">
        {d.radar.length === 0 ? (
          <Empty title="No tracked topics yet" />
        ) : (
          <>
            <ul className="space-y-3">
              {d.radar.slice(0, 10).map((row) => (
                <li key={row.topicId}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate">
                      {d.topicNames[row.topicId] ?? row.topicId}
                      <span className="dim text-xs">
                        {' '}
                        · {d.subjectNames[row.subjectId] ?? row.subjectId}
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums text-xs dim">
                      {row.predictedRetention === undefined
                        ? 'not yet reviewed'
                        : `${(row.predictedRetention * 100).toFixed(0)}%`}
                    </span>
                  </div>
                  {row.predictedRetention !== undefined && (
                    <div className="mt-1">
                      <Bar
                        value={row.predictedRetention * 100}
                        max={100}
                        tone={
                          row.predictedRetention < 0.7
                            ? 'danger'
                            : row.predictedRetention < 0.9
                              ? 'caution'
                              : 'positive'
                        }
                      />
                    </div>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs dim">
                    <Prov p="inferred" reason="FSRS forgetting curve, not an observation" />
                    <span>{row.reason}</span>
                    <span>· next due {formatDay(row.nextDueAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-xs dim">
              Recall percentages are model output from each card&apos;s review history. They are
              labelled estimated throughout because no one has observed what you currently
              remember — only what you answered.
            </p>
          </>
        )}
      </Card>
    </div>
  );
}
