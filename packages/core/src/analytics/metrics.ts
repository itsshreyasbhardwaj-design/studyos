/**
 * Deterministic analytics.
 *
 * Every number the UI shows comes from here, computed by arithmetic over
 * stored records. The AI layer may *interpret* these numbers but never
 * produces them, which is what stops the product from inventing statistics.
 */

import type { ActivityEvent, PracticeAttempt, Provenanced, Task } from '../types.ts';
import { aggregateEvents, type TimeTotals } from '../time/aggregate.ts';
import { DAY_MS } from '../revision/fsrs.ts';

export interface DayWindow {
  from: number;
  to: number;
}

export interface PeriodMetrics {
  window: DayWindow;
  time: TimeTotals;
  /** Active time as a share of elapsed recorded time, in [0,1]. */
  focusRatio: Provenanced<number>;
  tasksCompleted: number;
  tasksOutstanding: number;
  plannedMinutes: number;
  actualMinutes: Provenanced<number>;
  questionsAttempted: number;
  practiceAccuracy?: Provenanced<number>;
  reviewsCompleted: number;
  mistakesLogged: number;
}

export interface PeriodInput {
  window: DayWindow;
  events: readonly ActivityEvent[];
  tasks: readonly Task[];
  attempts: readonly PracticeAttempt[];
  /** Review timestamps, used to count completed reviews in the window. */
  reviewTimestamps?: readonly number[];
  plannedMinutes?: number;
  mistakesLogged?: number;
}

export function computePeriodMetrics(input: PeriodInput): PeriodMetrics {
  const { window, events, tasks, attempts, reviewTimestamps = [], plannedMinutes = 0 } = input;
  const time = aggregateEvents(events, window.from, window.to);

  const inWindow = <T extends { attemptedAt?: number; completedAt?: number }>(t: number) =>
    t >= window.from && t < window.to;

  const windowAttempts = attempts.filter((a) => inWindow(a.attemptedAt));
  const accuracy =
    windowAttempts.length > 0
      ? windowAttempts.reduce((s, a) => s + (a.score ?? (a.correct ? 1 : 0)), 0) /
        windowAttempts.length
      : undefined;

  // Any overlap means the active-time figure involved pro-rating, so it is
  // reported as inferred rather than measured.
  const activeProvenance = time.conflictMs > 0 ? 'inferred' : 'measured';

  return {
    window,
    time,
    focusRatio: {
      value: time.elapsedMs > 0 ? time.activeMs / time.elapsedMs : 0,
      provenance: activeProvenance,
      reason:
        time.conflictMs > 0
          ? `${Math.round(time.conflictMs / 60000)} min of overlapping device reports were attributed by precedence`
          : 'from recorded active-interaction time',
    },
    tasksCompleted: tasks.filter((t) => t.completedAt && inWindow(t.completedAt)).length,
    tasksOutstanding: tasks.filter((t) => !t.completedAt).length,
    plannedMinutes,
    actualMinutes: {
      value: Math.round(time.productiveMs / 60000),
      provenance: activeProvenance,
      reason: 'union of recorded productive activity, overlaps counted once',
    },
    questionsAttempted: windowAttempts.length,
    practiceAccuracy:
      accuracy === undefined
        ? undefined
        : {
            value: accuracy,
            provenance: 'demonstrated',
            reason: `${windowAttempts.length} graded attempts in this window`,
          },
    reviewsCompleted: reviewTimestamps.filter((t) => inWindow(t)).length,
    mistakesLogged: input.mistakesLogged ?? windowAttempts.filter((a) => !a.correct).length,
  };
}

/** Local-midnight day boundaries for a timestamp, honouring the host offset. */
export function dayWindow(at: number, timeZoneOffsetMinutes?: number): DayWindow {
  const offset = timeZoneOffsetMinutes ?? new Date(at).getTimezoneOffset();
  const local = at - offset * 60_000;
  const startLocal = Math.floor(local / DAY_MS) * DAY_MS;
  const from = startLocal + offset * 60_000;
  return { from, to: from + DAY_MS };
}

export function weekWindow(at: number, timeZoneOffsetMinutes?: number): DayWindow {
  const day = dayWindow(at, timeZoneOffsetMinutes);
  const dow = (new Date(day.from).getDay() + 6) % 7; // Monday = 0
  const from = day.from - dow * DAY_MS;
  return { from, to: from + 7 * DAY_MS };
}

export interface TrendPoint {
  window: DayWindow;
  productiveMinutes: number;
  focusRatio: number;
  accuracy?: number;
  reviewsCompleted: number;
}

/** Day-by-day series for charts. Gaps are zeros, not interpolations. */
export function dailyTrend(
  input: Omit<PeriodInput, 'window'>,
  from: number,
  days: number,
  timeZoneOffsetMinutes?: number,
): TrendPoint[] {
  const points: TrendPoint[] = [];
  for (let i = 0; i < days; i++) {
    const window = dayWindow(from + i * DAY_MS, timeZoneOffsetMinutes);
    const m = computePeriodMetrics({ ...input, window });
    points.push({
      window,
      productiveMinutes: Math.round(m.time.productiveMs / 60000),
      focusRatio: m.focusRatio.value,
      accuracy: m.practiceAccuracy?.value,
      reviewsCompleted: m.reviewsCompleted,
    });
  }
  return points;
}

/**
 * Consistency: share of days in the window with any productive time. Rewards
 * showing up, not marathon sessions — a deliberate choice, since the product
 * must not incentivise sleep deprivation.
 */
export function consistency(points: readonly TrendPoint[]): {
  activeDays: number;
  totalDays: number;
  ratio: number;
  longestStreak: number;
} {
  let longest = 0;
  let current = 0;
  let activeDays = 0;
  for (const p of points) {
    if (p.productiveMinutes > 0) {
      activeDays++;
      current++;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return {
    activeDays,
    totalDays: points.length,
    ratio: points.length > 0 ? activeDays / points.length : 0,
    longestStreak: longest,
  };
}

/** Planned vs actual, the honest version: both sides, plus the gap. */
export function planAdherence(metrics: PeriodMetrics): {
  plannedMinutes: number;
  actualMinutes: number;
  deltaMinutes: number;
  ratio?: number;
} {
  const actual = metrics.actualMinutes.value;
  return {
    plannedMinutes: metrics.plannedMinutes,
    actualMinutes: actual,
    deltaMinutes: actual - metrics.plannedMinutes,
    ratio: metrics.plannedMinutes > 0 ? actual / metrics.plannedMinutes : undefined,
  };
}
