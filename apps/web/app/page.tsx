import Link from 'next/link';
import { loadDashboard } from '../lib/queries.ts';
import { completeTaskAction, createTaskAction } from './actions.ts';
import { Bar, Card, Empty, Prov, Stat, formatDay, formatMin, formatTime, relativeDays } from './ui.tsx';

export const dynamic = 'force-dynamic';

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

export default function CommandCenter() {
  const d = loadDashboard();
  const m = d.metrics;
  const recordedMin = Math.round(m.time.productiveMs / 60_000);
  const activeMin = Math.round(m.time.activeMs / 60_000);
  const maxSubject = Math.max(1, ...Object.values(m.time.bySubject));

  // The single most useful thing to do next, chosen by the same deterministic
  // rules the planner uses — not a separate guess.
  const schedule = [...d.plan.allocations].sort((a, b) => a.startsAt! - b.startsAt!);
  const nextAllocation = schedule[0];
  const nextTask = nextAllocation ? d.tasks.find((t) => t.id === nextAllocation.taskId) : undefined;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Command Center</h1>
          <p className="text-sm dim mt-1">
            {new Date(d.now).toLocaleDateString([], {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })}
          </p>
        </div>
        <Link
          href="/focus"
          className="rounded-lg px-4 py-2 text-sm font-medium"
          style={{ background: 'var(--color-accent)', color: 'oklch(0.16 0.02 265)' }}
        >
          Start focus session
        </Link>
      </header>

      <Card>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Recorded today"
            value={formatMin(recordedMin)}
            sub="productive categories only"
            prov={m.actualMinutes}
          />
          <Stat
            label="Active interaction"
            value={formatMin(activeMin)}
            sub={`${(m.focusRatio.value * 100).toFixed(0)}% of recorded time`}
            prov={m.focusRatio}
          />
          <Stat
            label="Tasks done"
            value={`${m.tasksCompleted}`}
            sub={`${m.tasksOutstanding} still open`}
          />
          <Stat
            label="Practice accuracy"
            value={m.practiceAccuracy ? `${(m.practiceAccuracy.value * 100).toFixed(0)}%` : '—'}
            sub={
              m.practiceAccuracy
                ? `${m.questionsAttempted} graded today`
                : 'no graded questions today'
            }
            prov={m.practiceAccuracy}
          />
        </div>
      </Card>

      {nextTask && (
        <Card title="Recommended next">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-lg font-medium">{nextTask.title}</div>
              <div className="text-sm dim mt-1">
                {formatMin(Math.round(nextAllocation!.minutes))} ·{' '}
                {d.subjectNames[nextTask.subjectId ?? ''] ?? 'No subject'}
                {nextTask.dueAt ? ` · due ${relativeDays(nextTask.dueAt, d.now)}` : ''}
              </div>
              <div className="text-xs dim mt-1">
                {d.plan.explanations.find((e) => e.taskId === nextTask.id)?.because}
              </div>
            </div>
            <Link
              href="/focus"
              className="rounded-lg border px-3 py-1.5 text-sm"
              style={{ borderColor: 'var(--border)' }}
            >
              Focus on this
            </Link>
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="Next up"
          action={
            <Link href="/planner" className="text-xs dim underline">
              Full planner
            </Link>
          }
        >
          {d.plan.revisionReserved && (
            <div
              className="mb-3 rounded-lg px-3 py-2 text-xs"
              style={{ background: 'var(--surface-hover)' }}
            >
              Revision protected {formatTime(d.plan.revisionReserved.startsAt)}–
              {formatTime(d.plan.revisionReserved.endsAt)} · {d.dueCount} cards due
            </div>
          )}
          {d.plan.allocations.length === 0 ? (
            <Empty
              title="Nothing scheduled"
              hint="Add free time in the planner, or create a task below."
            />
          ) : (
            <ul className="space-y-2">
              {schedule.slice(0, 6).map((a, i) => {
                const task = d.tasks.find((t) => t.id === a.taskId);
                return (
                  <li key={`${a.taskId}-${i}`} className="flex items-center gap-3 text-sm">
                    <span className="w-36 shrink-0 tabular-nums dim text-xs">
                      {!sameDay(a.startsAt!, d.now) && (
                        <span className="mr-1">{formatDay(a.startsAt!)}</span>
                      )}
                      {formatTime(a.startsAt!)}–{formatTime(a.endsAt!)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{task?.title ?? a.taskId}</span>
                    <span className="shrink-0 text-xs dim tabular-nums">
                      {formatMin(Math.round(a.minutes))}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {!d.plan.feasible && (
            <p className="mt-3 text-xs" style={{ color: 'var(--color-caution)' }}>
              {d.plan.unscheduled.length > 0
                ? `${d.plan.unscheduled.length} item(s) could not be placed in the free time available.`
                : `Everything fits, but ${d.plan.risks.filter((r) => r.verdict === 'will_miss').length} deadline(s) land too late.`}{' '}
              The planner says so rather than silently dropping them.
            </p>
          )}
        </Card>

        <Card
          title="Revision due"
          action={
            <Link href="/revision" className="text-xs dim underline">
              Start reviewing
            </Link>
          }
        >
          {d.queue.cards.length === 0 ? (
            <Empty title="Nothing due right now" hint="FSRS will surface cards as they decay." />
          ) : (
            <>
              <ul className="space-y-2.5">
                {d.queue.cards.slice(0, 5).map((c) => (
                  <li key={c.id} className="text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate">
                        {d.subjectNames[c.subjectId] ?? c.subjectId}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums dim">
                        {c.predictedRetention === undefined
                          ? 'new'
                          : `${(c.predictedRetention * 100).toFixed(0)}% recall`}
                      </span>
                    </div>
                    {c.predictedRetention !== undefined && (
                      <div className="mt-1">
                        <Bar
                          value={c.predictedRetention * 100}
                          max={100}
                          tone={c.predictedRetention < 0.7 ? 'danger' : 'caution'}
                        />
                      </div>
                    )}
                    <div className="text-xs dim mt-1">{c.reason}</div>
                  </li>
                ))}
              </ul>
              {d.queue.backlogCount > 0 && (
                <p className="mt-3 text-xs dim">
                  {d.queue.backlogCount} more due beyond this session —{' '}
                  {d.queue.backlogSessions} sessions to clear at 20 cards each.
                </p>
              )}
            </>
          )}
        </Card>

        <Card title="Where today's time went">
          {Object.keys(m.time.bySubject).length === 0 ? (
            <Empty title="No recorded activity today" hint="Run a focus session to record time." />
          ) : (
            <ul className="space-y-3">
              {Object.entries(m.time.bySubject)
                .sort((a, b) => b[1] - a[1])
                .map(([subjectId, ms]) => (
                  <li key={subjectId}>
                    <div className="flex justify-between text-sm">
                      <span>{d.subjectNames[subjectId] ?? subjectId}</span>
                      <span className="tabular-nums dim">
                        {formatMin(Math.round(ms / 60_000))}
                      </span>
                    </div>
                    <div className="mt-1">
                      <Bar value={ms} max={maxSubject} />
                    </div>
                  </li>
                ))}
            </ul>
          )}
          {m.time.conflictMs > 0 && (
            <p className="mt-3 flex items-center gap-2 text-xs dim">
              <Prov p="inferred" />
              {Math.round(m.time.conflictMs / 60_000)} min came from two devices at once and was
              attributed to one of them.
            </p>
          )}
        </Card>

        <Card title="Upcoming exams">
          {d.exams.length === 0 ? (
            <Empty title="No exams scheduled" />
          ) : (
            <ul className="space-y-2.5">
              {d.exams.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <div className="truncate">{e.title}</div>
                    <div className="text-xs dim">{d.subjectNames[e.subjectId]}</div>
                  </div>
                  <span
                    className="shrink-0 text-xs tabular-nums"
                    style={{
                      color:
                        e.startsAt - d.now < 14 * 86_400_000
                          ? 'var(--color-caution)'
                          : 'var(--text-dim)',
                    }}
                  >
                    {relativeDays(e.startsAt, d.now)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Open tasks">
        <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
          {d.tasks.length === 0 && <Empty title="No open tasks" />}
          {d.tasks.slice(0, 8).map((t) => (
            <li key={t.id} className="flex items-center gap-3 py-2.5">
              <form action={completeTaskAction.bind(null, t.id)}>
                <button
                  type="submit"
                  aria-label={`Mark ${t.title} complete`}
                  className="grid size-5 place-items-center rounded-full border text-[10px]"
                  style={{ borderColor: 'var(--border)' }}
                >
                  ✓
                </button>
              </form>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{t.title}</div>
                <div className="text-xs dim">
                  {d.subjectNames[t.subjectId ?? ''] ?? 'No subject'} ·{' '}
                  {formatMin(t.estimateMin)} estimated
                  {t.actualMin ? ` · ${formatMin(t.actualMin)} logged` : ''}
                  {t.dependsOn?.length ? ' · has a prerequisite' : ''}
                </div>
              </div>
              {t.dueAt && (
                <span
                  className="shrink-0 text-xs tabular-nums"
                  style={{
                    color: t.dueAt < d.now ? 'var(--color-danger)' : 'var(--text-dim)',
                  }}
                >
                  {relativeDays(t.dueAt, d.now)}
                </span>
              )}
            </li>
          ))}
        </ul>

        <form action={createTaskAction} className="mt-4 flex flex-wrap gap-2">
          <input
            name="title"
            required
            placeholder="New task"
            className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
          />
          <select
            name="subjectId"
            className="rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
            aria-label="Subject"
          >
            <option value="">No subject</option>
            {d.subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <input
            name="estimateMin"
            type="number"
            min="5"
            step="5"
            defaultValue={30}
            aria-label="Estimated minutes"
            className="w-24 rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
          />
          <input
            name="dueAt"
            type="date"
            aria-label="Due date"
            className="rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
          />
          <button
            type="submit"
            className="rounded-lg px-4 py-2 text-sm font-medium"
            style={{ background: 'var(--surface-hover)' }}
          >
            Add
          </button>
        </form>
      </Card>
    </div>
  );
}
