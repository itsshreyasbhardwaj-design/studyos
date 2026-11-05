import { loadPlanner } from '../../lib/queries.ts';
import { Card, Empty, formatDay, formatMin, formatTime, relativeDays } from '../ui.tsx';

export const dynamic = 'force-dynamic';

export default function PlannerPage() {
  const d = loadPlanner();
  const current = d.scenarios[0].plan;

  // Group the week's allocations by day for a readable schedule.
  const byDay = new Map<string, typeof current.allocations>();
  for (const a of current.allocations) {
    const key = new Date(a.startsAt!).toDateString();
    const list = byDay.get(key);
    if (list) list.push(a);
    else byDay.set(key, [a]);
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Planner</h1>
        <p className="text-sm dim mt-1">
          Deterministic: same tasks, same free time, same plan. Every placement has a stated
          reason.
        </p>
      </header>

      <Card>
        <div className="grid gap-5 sm:grid-cols-4">
          <div>
            <div className="text-xs dim uppercase tracking-wide">Free time</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">
              {formatMin(Math.round(current.supplyMinutes))}
            </div>
          </div>
          <div>
            <div className="text-xs dim uppercase tracking-wide">Work outstanding</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">
              {formatMin(Math.round(current.demandMinutes))}
            </div>
          </div>
          <div>
            <div className="text-xs dim uppercase tracking-wide">Verdict</div>
            <div
              className="mt-1 text-2xl font-semibold"
              style={{
                color: current.feasible ? 'var(--color-positive)' : 'var(--color-caution)',
              }}
            >
              {current.feasible
                ? 'Fits'
                : current.unscheduled.length > 0
                  ? 'Over capacity'
                  : 'Deadline risk'}
            </div>
          </div>
          <div>
            <div className="text-xs dim uppercase tracking-wide">Deadlines at risk</div>
            <div
              className="mt-1 text-2xl font-semibold tabular-nums"
              style={{
                color: current.risks.length > 0 ? 'var(--color-danger)' : 'var(--color-positive)',
              }}
            >
              {current.risks.length}
            </div>
          </div>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card title="Schedule">
          {byDay.size === 0 ? (
            <Empty
              title="Nothing could be scheduled"
              hint="There is no free time recorded in the next week."
            />
          ) : (
            <div className="space-y-5">
              {[...byDay.entries()].map(([day, allocations]) => (
                <div key={day}>
                  <div className="mb-2 text-xs font-medium uppercase tracking-wide dim">
                    {formatDay(allocations[0].startsAt!)}
                    <span className="ml-2 normal-case tabular-nums">
                      {formatMin(Math.round(allocations.reduce((s, a) => s + a.minutes, 0)))}
                    </span>
                  </div>
                  <ul className="space-y-1.5">
                    {allocations.map((a, i) => (
                      <li key={i} className="flex items-center gap-3 text-sm">
                        <span className="w-24 shrink-0 text-xs tabular-nums dim">
                          {formatTime(a.startsAt!)}–{formatTime(a.endsAt!)}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {d.taskNames[a.taskId] ?? a.taskId}
                        </span>
                        <span className="shrink-0 text-xs tabular-nums dim">
                          {formatMin(Math.round(a.minutes))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Card>

        <div className="space-y-6">
          <Card title="Subject budgets">
            {current.budgets.length === 0 ? (
              <Empty title="No time allocated" />
            ) : (
              <ul className="space-y-2">
                {current.budgets.map((b) => (
                  <li key={b.subjectId} className="flex justify-between text-sm">
                    <span>{d.subjectNames[b.subjectId] ?? 'Unassigned'}</span>
                    <span className="tabular-nums dim">{formatMin(Math.round(b.minutes))}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs dim">
              Planning without exact timestamps: these totals are the plan, whatever order you
              work in.
            </p>
          </Card>

          {current.risks.length > 0 && (
            <Card title="Deadline risk">
              <ul className="space-y-3">
                {current.risks.map((r) => (
                  <li key={r.taskId} className="text-sm">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 truncate">{d.taskNames[r.taskId] ?? r.taskId}</span>
                      <span
                        className="shrink-0 text-xs uppercase tracking-wide"
                        style={{
                          color:
                            r.verdict === 'will_miss'
                              ? 'var(--color-danger)'
                              : 'var(--color-caution)',
                        }}
                      >
                        {r.verdict === 'will_miss' ? 'will miss' : 'tight'}
                      </span>
                    </div>
                    <div className="text-xs dim mt-0.5">
                      due {relativeDays(r.dueAt, d.now)}
                      {r.shortfallMinutes > 0
                        ? ` · ${formatMin(r.shortfallMinutes)} short of the estimate`
                        : ''}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {current.unscheduled.length > 0 && (
            <Card title="Could not be scheduled">
              <ul className="space-y-2.5">
                {current.unscheduled.map((u) => (
                  <li key={u.taskId} className="text-sm">
                    <div className="truncate">{d.taskNames[u.taskId] ?? u.taskId}</div>
                    <div className="text-xs dim mt-0.5">
                      {formatMin(u.remainingMinutes)} left · {u.reason}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      <Card title="What if">
        <div className="grid gap-4 sm:grid-cols-3">
          {d.scenarios.map((s) => (
            <div
              key={s.label}
              className="rounded-xl border p-4"
              style={{ borderColor: 'var(--border)' }}
            >
              <div className="text-sm font-medium">{s.label}</div>
              <dl className="mt-3 space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <dt className="dim">Free time</dt>
                  <dd className="tabular-nums">{formatMin(Math.round(s.plan.supplyMinutes))}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="dim">Scheduled</dt>
                  <dd className="tabular-nums">
                    {formatMin(
                      Math.round(s.plan.allocations.reduce((sum, a) => sum + a.minutes, 0)),
                    )}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="dim">Unscheduled</dt>
                  <dd className="tabular-nums">{s.plan.unscheduled.length}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="dim">Deadlines at risk</dt>
                  <dd
                    className="tabular-nums"
                    style={{
                      color: s.plan.risks.length > 0 ? 'var(--color-danger)' : 'inherit',
                    }}
                  >
                    {s.plan.risks.length}
                  </dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs dim">
          These are arithmetic consequences of the inputs, not predictions about results. StudyOS
          does not estimate grades.
        </p>
      </Card>

      <Card title="Why this order">
        <ul className="space-y-1.5 text-sm">
          {current.explanations
            .slice()
            .sort((a, b) => b.score - a.score)
            .slice(0, 10)
            .map((e) => (
              <li key={e.taskId} className="flex flex-wrap items-baseline gap-x-2">
                <span className="w-10 shrink-0 text-xs tabular-nums dim">
                  {e.score.toFixed(0)}
                </span>
                <span className="min-w-0 flex-1 truncate">{d.taskNames[e.taskId] ?? e.taskId}</span>
                <span className="text-xs dim">{e.because}</span>
              </li>
            ))}
        </ul>
      </Card>
    </div>
  );
}
