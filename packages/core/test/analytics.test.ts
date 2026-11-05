import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePeriodMetrics,
  dayWindow,
  weekWindow,
  dailyTrend,
  consistency,
  planAdherence,
} from '../src/analytics/metrics.ts';
import { buildDailyReport, formatMinutes } from '../src/report/daily.ts';
import { forgetfulnessRadar } from '../src/revision/radar.ts';
import { plan } from '../src/planning/scheduler.ts';
import type { ActivityEvent, PracticeAttempt, Task } from '../src/types.ts';

const H = 3_600_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 5, 9, 0, 0);
const WINDOW = { from: Date.UTC(2026, 10, 5, 0, 0, 0), to: Date.UTC(2026, 10, 6, 0, 0, 0) };

const events: ActivityEvent[] = [
  { id: 'e1', deviceId: 'laptop', startedAt: T0, endedAt: T0 + 2 * H, activeMs: 1.5 * H, category: 'deep_study', provenance: 'measured', subjectId: 'maths' },
  { id: 'e2', deviceId: 'laptop', startedAt: T0 + 2 * H, endedAt: T0 + 2.5 * H, activeMs: 0.5 * H, category: 'break', provenance: 'measured' },
  { id: 'e3', deviceId: 'phone', startedAt: T0 + 3 * H, endedAt: T0 + 3.5 * H, activeMs: 0.5 * H, category: 'revision', provenance: 'measured', subjectId: 'physics' },
];

const tasks: Task[] = [
  { id: 't1', title: 'Vectors problem set', estimateMin: 60, priority: 1, completedAt: T0 + 2 * H },
  { id: 't2', title: 'Lab write-up', estimateMin: 90, priority: 2 },
];

const attempts: PracticeAttempt[] = [
  { id: 'p1', topicId: 'vectors', attemptedAt: T0 + H, correct: true },
  { id: 'p2', topicId: 'vectors', attemptedAt: T0 + H, correct: false, errorCategory: 'sign error' },
  { id: 'p3', topicId: 'vectors', attemptedAt: T0 + H, correct: true },
  { id: 'p4', topicId: 'vectors', attemptedAt: T0 - 5 * DAY, correct: false },
];

test('period metrics only count records inside the window', () => {
  const m = computePeriodMetrics({ window: WINDOW, events, tasks, attempts });
  assert.equal(m.questionsAttempted, 3, 'the attempt five days ago must be excluded');
  assert.equal(m.tasksCompleted, 1);
  assert.equal(m.tasksOutstanding, 1);
});

test('productive time excludes breaks', () => {
  const m = computePeriodMetrics({ window: WINDOW, events, tasks, attempts });
  assert.equal(m.time.productiveMs, 2.5 * H, 'two hours study plus half an hour revision');
  assert.equal(m.time.breakMs, 0.5 * H);
  assert.equal(m.actualMinutes.value, 150);
});

test('accuracy is labelled as demonstrated, not estimated', () => {
  const m = computePeriodMetrics({ window: WINDOW, events, tasks, attempts });
  assert.ok(Math.abs(m.practiceAccuracy!.value - 2 / 3) < 1e-9);
  assert.equal(m.practiceAccuracy!.provenance, 'demonstrated');
});

test('no attempts yields no accuracy rather than zero', () => {
  const m = computePeriodMetrics({ window: WINDOW, events, tasks, attempts: [] });
  assert.equal(m.practiceAccuracy, undefined, 'a missing figure must not render as 0%');
});

test('focus ratio is measured when there is no device overlap', () => {
  const m = computePeriodMetrics({ window: WINDOW, events, tasks, attempts });
  assert.equal(m.focusRatio.provenance, 'measured');
  assert.ok(m.focusRatio.value > 0 && m.focusRatio.value <= 1);
});

test('focus ratio downgrades to inferred when devices overlapped', () => {
  const overlapping: ActivityEvent[] = [
    ...events,
    { id: 'e4', deviceId: 'tablet', startedAt: T0, endedAt: T0 + H, activeMs: H, category: 'reading', provenance: 'measured' },
  ];
  const m = computePeriodMetrics({ window: WINDOW, events: overlapping, tasks, attempts });
  assert.equal(m.focusRatio.provenance, 'inferred');
  assert.match(m.focusRatio.reason!, /overlapping/);
});

test('day and week windows are exactly one day and seven days long', () => {
  const d = dayWindow(T0);
  assert.equal(d.to - d.from, DAY);
  assert.ok(T0 >= d.from && T0 < d.to);
  const w = weekWindow(T0);
  assert.equal(w.to - w.from, 7 * DAY);
  assert.ok(T0 >= w.from && T0 < w.to);
});

test('weeks start on Monday', () => {
  const w = weekWindow(T0);
  assert.equal(new Date(w.from).getDay(), 1);
});

test('trend has one point per day and zero-fills quiet days', () => {
  const points = dailyTrend({ events, tasks, attempts }, WINDOW.from, 5);
  assert.equal(points.length, 5);
  assert.equal(points[0].productiveMinutes, 150);
  assert.equal(points[3].productiveMinutes, 0, 'quiet days are zero, not interpolated');
});

test('consistency counts days shown up, not hours piled on', () => {
  const c = consistency([
    { window: WINDOW, productiveMinutes: 20, focusRatio: 1, reviewsCompleted: 0 },
    { window: WINDOW, productiveMinutes: 0, focusRatio: 0, reviewsCompleted: 0 },
    { window: WINDOW, productiveMinutes: 600, focusRatio: 1, reviewsCompleted: 0 },
    { window: WINDOW, productiveMinutes: 15, focusRatio: 1, reviewsCompleted: 0 },
  ]);
  assert.equal(c.activeDays, 3);
  assert.equal(c.totalDays, 4);
  assert.equal(c.longestStreak, 2);
});

test('plan adherence reports both sides and the gap', () => {
  const m = computePeriodMetrics({ window: WINDOW, events, tasks, attempts, plannedMinutes: 180 });
  const a = planAdherence(m);
  assert.equal(a.plannedMinutes, 180);
  assert.equal(a.actualMinutes, 150);
  assert.equal(a.deltaMinutes, -30);
});

test('daily report carries provenance on every headline number', () => {
  const m = computePeriodMetrics({ window: WINDOW, events, tasks, attempts, plannedMinutes: 180 });
  const report = buildDailyReport({ at: T0, metrics: m, radar: [] });
  assert.equal(report.date, '2026-11-05');
  assert.equal(report.metrics.recordedMinutes.provenance, 'measured');
  assert.ok(report.metrics.recordedMinutes.reason);
  assert.equal(report.metrics.activeMinutes.provenance, 'measured');
  assert.equal(report.metrics.practiceAccuracy!.provenance, 'demonstrated');
  assert.ok(report.observations.length > 0);
  assert.equal(report.reflectionPrompts.length, 3);
});

test('a report with no activity says so instead of showing an empty dashboard', () => {
  const m = computePeriodMetrics({ window: WINDOW, events: [], tasks: [], attempts: [] });
  const report = buildDailyReport({ at: T0, metrics: m, radar: [] });
  assert.equal(report.headline, 'No activity recorded today');
  assert.match(report.observations.join(' '), /add a manual session/);
});

test('a report flags time studied with no graded evidence of learning', () => {
  const m = computePeriodMetrics({ window: WINDOW, events, tasks, attempts: [] });
  const report = buildDailyReport({ at: T0, metrics: m, radar: [] });
  assert.match(report.observations.join(' '), /only of time spent/);
});

test('device overlap surfaces as a data-quality warning', () => {
  const overlapping: ActivityEvent[] = [
    ...events,
    { id: 'e4', deviceId: 'tablet', startedAt: T0, endedAt: T0 + H, activeMs: H, category: 'reading', provenance: 'measured' },
  ];
  const m = computePeriodMetrics({ window: WINDOW, events: overlapping, tasks, attempts });
  const report = buildDailyReport({ at: T0, metrics: m, radar: [] });
  assert.ok(report.dataQuality.length > 0);
  assert.match(report.dataQuality.join(' '), /overlapping reports/);
});

test('an infeasible tomorrow is stated plainly in the report', () => {
  const m = computePeriodMetrics({ window: WINDOW, events, tasks, attempts });
  const tomorrowPlan = plan({
    now: T0 + DAY,
    tasks: [{ id: 'big', title: 'Essay', estimateMin: 600, priority: 1, dueAt: T0 + DAY + 2 * H }],
    availability: [{ startsAt: T0 + DAY, endsAt: T0 + DAY + 2 * H }],
  });
  const report = buildDailyReport({ at: T0, metrics: m, radar: [], tomorrowPlan });
  assert.match(report.observations.join(' '), /does not fit the time available/);
});

test('report revise-next rows come from the radar with their reasons', () => {
  const m = computePeriodMetrics({ window: WINDOW, events, tasks, attempts });
  const radar = forgetfulnessRadar(
    [
      {
        id: 'c1',
        topicId: 'vectors',
        subjectId: 'maths',
        state: { stability: 2, difficulty: 6, lastReviewedAt: T0 - 40 * DAY, dueAt: T0 - DAY, reps: 3, lapses: 2 },
      },
    ],
    T0,
  );
  const report = buildDailyReport({ at: T0, metrics: m, radar });
  assert.equal(report.reviseNext.length, 1);
  assert.equal(report.reviseNext[0].topicId, 'vectors');
  assert.match(report.reviseNext[0].reason, /modelled recall/);
});

test('formatMinutes reads naturally', () => {
  assert.equal(formatMinutes(45), '45m');
  assert.equal(formatMinutes(60), '1h');
  assert.equal(formatMinutes(150), '2h 30m');
});
