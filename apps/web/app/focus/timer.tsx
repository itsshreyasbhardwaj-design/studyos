'use client';

import { useEffect, useRef, useState } from 'react';
import { saveFocusSessionAction } from '../actions.ts';
import { formatMin } from '../ui.tsx';

const MODES = [
  { id: 'pomodoro', label: 'Pomodoro', minutes: 25, category: 'deep_study' },
  { id: 'deep_work', label: 'Deep Work', minutes: 50, category: 'deep_study' },
  { id: 'revision', label: 'Revision', minutes: 20, category: 'revision' },
  { id: 'practice', label: 'Exam Practice', minutes: 45, category: 'practice' },
  { id: 'reading', label: 'Reading', minutes: 30, category: 'reading' },
  { id: 'coding', label: 'Coding', minutes: 45, category: 'programming' },
  { id: 'stopwatch', label: 'Stopwatch', minutes: 0, category: 'deep_study' },
] as const;

type Subject = { id: string; name: string };
type Task = { id: string; title: string; subjectId?: string };

export function FocusTimer({ subjects, tasks }: { subjects: Subject[]; tasks: Task[] }) {
  const [modeId, setModeId] = useState<string>('pomodoro');
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  /** Time spent paused is excluded from active time, never from elapsed. */
  const [pausedMs, setPausedMs] = useState(0);
  const [subjectId, setSubjectId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [goal, setGoal] = useState('');
  const [reflection, setReflection] = useState('');
  const [finished, setFinished] = useState<{ minutes: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const pauseStart = useRef<number | null>(null);

  const mode = MODES.find((m) => m.id === modeId)!;
  const targetMs = mode.minutes * 60_000;

  useEffect(() => {
    if (!running || startedAt === null) return;
    const tick = () => setElapsedMs(Date.now() - startedAt);
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [running, startedAt]);

  const activeMs = Math.max(0, elapsedMs - pausedMs);
  const remainingMs = targetMs > 0 ? Math.max(0, targetMs - activeMs) : 0;
  const display = targetMs > 0 ? remainingMs : activeMs;
  const reachedTarget = targetMs > 0 && remainingMs === 0 && startedAt !== null;

  function start() {
    setStartedAt(Date.now());
    setElapsedMs(0);
    setPausedMs(0);
    setFinished(null);
    setRunning(true);
    pauseStart.current = null;
  }

  function togglePause() {
    if (pauseStart.current === null) {
      pauseStart.current = Date.now();
      setRunning(false);
    } else {
      setPausedMs((p) => p + (Date.now() - pauseStart.current!));
      pauseStart.current = null;
      setRunning(true);
    }
  }

  async function finish() {
    if (startedAt === null) return;
    const endedAt = Date.now();
    const pausedTotal =
      pausedMs + (pauseStart.current !== null ? endedAt - pauseStart.current : 0);
    setRunning(false);
    setSaving(true);
    const result = await saveFocusSessionAction({
      startedAt,
      endedAt,
      activeMs: Math.max(0, endedAt - startedAt - pausedTotal),
      category: mode.category,
      subjectId: subjectId || undefined,
      taskId: taskId || undefined,
      mode: mode.id,
      goal: goal || undefined,
      reflection: reflection || undefined,
    });
    setSaving(false);
    if ('ok' in result && result.ok) {
      setFinished({ minutes: result.minutes });
      setStartedAt(null);
      setElapsedMs(0);
      setPausedMs(0);
      pauseStart.current = null;
    }
  }

  const mm = String(Math.floor(display / 60_000)).padStart(2, '0');
  const ss = String(Math.floor((display % 60_000) / 1000)).padStart(2, '0');
  const pausedNow = startedAt !== null && !running;

  const filteredTasks = subjectId ? tasks.filter((t) => t.subjectId === subjectId) : tasks;

  return (
    <div className="space-y-6">
      <div className="card p-8 text-center">
        <div
          className="font-mono tabular-nums"
          style={{ fontSize: 'clamp(3.5rem, 14vw, 7rem)', lineHeight: 1, letterSpacing: '-0.03em' }}
          aria-live="off"
        >
          {mm}:{ss}
        </div>
        <div className="mt-2 text-sm dim">
          {startedAt === null
            ? `${mode.label}${mode.minutes ? ` · ${mode.minutes} min` : ' · counting up'}`
            : pausedNow
              ? 'Paused — paused time is excluded from active time'
              : reachedTarget
                ? 'Target reached. Finish when you are ready.'
                : `${mode.label} in progress`}
        </div>

        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {startedAt === null ? (
            <button
              onClick={start}
              className="rounded-lg px-6 py-2.5 text-sm font-medium"
              style={{ background: 'var(--color-accent)', color: 'oklch(0.16 0.02 265)' }}
            >
              Start
            </button>
          ) : (
            <>
              <button
                onClick={togglePause}
                className="rounded-lg border px-5 py-2.5 text-sm"
                style={{ borderColor: 'var(--border)' }}
              >
                {pausedNow ? 'Resume' : 'Pause'}
              </button>
              <button
                onClick={finish}
                disabled={saving}
                className="rounded-lg px-5 py-2.5 text-sm font-medium disabled:opacity-50"
                style={{ background: 'var(--color-positive)', color: 'oklch(0.16 0.02 160)' }}
              >
                {saving ? 'Saving…' : 'Finish and save'}
              </button>
            </>
          )}
        </div>

        {startedAt !== null && (
          <div className="mt-4 text-xs dim tabular-nums">
            elapsed {formatMin(Math.round(elapsedMs / 60_000))} · active{' '}
            {formatMin(Math.round(activeMs / 60_000))}
            {pausedMs > 0 ? ` · paused ${formatMin(Math.round(pausedMs / 60_000))}` : ''}
          </div>
        )}

        {finished && (
          <p className="mt-4 text-sm" style={{ color: 'var(--color-positive)' }}>
            Saved {formatMin(finished.minutes)} as a confirmed session.
          </p>
        )}
      </div>

      <div className="card p-5">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide dim">Mode</h2>
        <div className="flex flex-wrap gap-2">
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => startedAt === null && setModeId(m.id)}
              disabled={startedAt !== null}
              aria-pressed={modeId === m.id}
              className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-40"
              style={{
                borderColor: modeId === m.id ? 'var(--color-accent)' : 'var(--border)',
                color: modeId === m.id ? 'var(--color-accent)' : 'var(--text)',
              }}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className="text-sm">
            <span className="dim text-xs uppercase tracking-wide">Subject</span>
            <select
              value={subjectId}
              onChange={(e) => {
                setSubjectId(e.target.value);
                setTaskId('');
              }}
              className="mt-1 w-full rounded-lg border px-3 py-2"
              style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
            >
              <option value="">Not set</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="dim text-xs uppercase tracking-wide">Task</span>
            <select
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2"
              style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
            >
              <option value="">Not linked</option>
              {filteredTasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm sm:col-span-2">
            <span className="dim text-xs uppercase tracking-wide">Session goal</span>
            <input
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="What will be true at the end of this session?"
              className="mt-1 w-full rounded-lg border px-3 py-2"
              style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
            />
          </label>

          {startedAt !== null && (
            <label className="text-sm sm:col-span-2">
              <span className="dim text-xs uppercase tracking-wide">
                Reflection (saved with the session)
              </span>
              <textarea
                value={reflection}
                onChange={(e) => setReflection(e.target.value)}
                rows={2}
                placeholder="What did you actually learn? What was hard?"
                className="mt-1 w-full rounded-lg border px-3 py-2"
                style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
              />
            </label>
          )}
        </div>

        <p className="mt-4 text-xs dim">
          Sessions saved here are recorded as <span className="prov prov-confirmed">you confirmed</span>{' '}
          — a human stated they happened. Automatic OS-level tracking would be recorded as
          measured; see the capability matrix for what this build does and does not track.
        </p>
      </div>
    </div>
  );
}
