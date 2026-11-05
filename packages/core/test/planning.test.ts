import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, orderByDependencies, scoreTask, compareScenarios } from '../src/planning/scheduler.ts';
import type { AvailabilityBlock, Task } from '../src/types.ts';

const NOW = Date.UTC(2026, 10, 5, 9, 0, 0);
const H = 3_600_000;

function task(p: Partial<Task> & Pick<Task, 'id'>): Task {
  return { title: p.id, estimateMin: 60, priority: 2, ...p };
}

const fourHours: AvailabilityBlock[] = [{ startsAt: NOW, endsAt: NOW + 4 * H }];

test('allocations never exceed available time', () => {
  const result = plan({
    now: NOW,
    tasks: [
      task({ id: 'a', estimateMin: 120 }),
      task({ id: 'b', estimateMin: 120 }),
      task({ id: 'c', estimateMin: 120 }),
    ],
    availability: fourHours,
  });
  const scheduled = result.allocations.reduce((s, a) => s + a.minutes, 0);
  assert.ok(scheduled <= 240, `scheduled ${scheduled} min into 240 min`);
  assert.equal(result.supplyMinutes, 240);
  assert.equal(result.demandMinutes, 360);
  assert.ok(result.unscheduled.length > 0, 'the overflow must be reported');
  assert.equal(result.feasible, false);
});

test('allocations never overlap each other', () => {
  const result = plan({
    now: NOW,
    tasks: [task({ id: 'a', estimateMin: 60 }), task({ id: 'b', estimateMin: 60 })],
    availability: fourHours,
  });
  const sorted = [...result.allocations].sort((x, y) => x.startsAt! - y.startsAt!);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i].startsAt! >= sorted[i - 1].endsAt!, 'plan double-books time');
  }
});

test('revision time is protected before any task work', () => {
  const result = plan({
    now: NOW,
    tasks: [task({ id: 'a', estimateMin: 240 })],
    availability: fourHours,
    revisionMinutes: 30,
  });
  assert.ok(result.revisionReserved, 'revision block must exist');
  assert.equal(result.revisionReserved!.startsAt, NOW);
  const earliestTask = Math.min(...result.allocations.map((a) => a.startsAt!));
  assert.ok(earliestTask >= result.revisionReserved!.endsAt, 'task work ate the revision slot');
});

test('fixed commitments are never scheduled over', () => {
  const result = plan({
    now: NOW,
    tasks: [task({ id: 'a', estimateMin: 240 })],
    availability: [
      { startsAt: NOW, endsAt: NOW + 4 * H },
      { startsAt: NOW + H, endsAt: NOW + 2 * H, fixed: true, label: 'Lesson' },
    ],
  });
  for (const a of result.allocations) {
    const clashes = a.startsAt! < NOW + 2 * H && a.endsAt! > NOW + H;
    assert.ok(!clashes, 'scheduled over a fixed commitment');
  }
});

test('dependencies are scheduled in order', () => {
  const result = plan({
    now: NOW,
    tasks: [
      task({ id: 'write-up', estimateMin: 60, dependsOn: ['experiment'] }),
      task({ id: 'experiment', estimateMin: 60 }),
    ],
    availability: fourHours,
  });
  const expEnd = Math.max(
    ...result.allocations.filter((a) => a.taskId === 'experiment').map((a) => a.endsAt!),
  );
  const writeStart = Math.min(
    ...result.allocations.filter((a) => a.taskId === 'write-up').map((a) => a.startsAt!),
  );
  assert.ok(writeStart >= expEnd, 'dependent task started before its prerequisite finished');
});

test('a completed prerequisite no longer blocks its dependent', () => {
  const { ordered } = orderByDependencies([
    task({ id: 'b', dependsOn: ['a'] }),
    task({ id: 'a', completedAt: NOW - H }),
  ]);
  assert.deepEqual(ordered.map((t) => t.id), ['b']);
});

test('circular dependencies are reported, not silently dropped or looped', () => {
  const tasks = [
    task({ id: 'x', dependsOn: ['y'] }),
    task({ id: 'y', dependsOn: ['x'] }),
  ];
  const { cycles } = orderByDependencies(tasks);
  assert.ok(cycles.length > 0, 'cycle must be detected');

  const result = plan({ now: NOW, tasks, availability: fourHours });
  assert.equal(result.allocations.length, 0);
  assert.equal(result.unscheduled.length, 2);
  assert.ok(result.unscheduled.every((u) => /circular/.test(u.reason)));
});

test('an overdue task outranks a distant one', () => {
  const overdue = scoreTask(task({ id: 'late', dueAt: NOW - 2 * 86_400_000 }), NOW);
  const distant = scoreTask(task({ id: 'later', dueAt: NOW + 30 * 86_400_000 }), NOW);
  assert.ok(overdue.score > distant.score);
  assert.match(overdue.because, /overdue/);
});

test('an imminent exam lifts that subject', () => {
  const exams = [{ id: 'e', subjectId: 'physics', title: 'Paper 1', startsAt: NOW + 4 * 86_400_000 }];
  const withExam = scoreTask(task({ id: 'p', subjectId: 'physics' }), NOW, exams);
  const without = scoreTask(task({ id: 'q', subjectId: 'art' }), NOW, exams);
  assert.ok(withExam.score > without.score);
  assert.match(withExam.because, /Paper 1 in \d+d/);
});

test('every task gets a stated reason for its position', () => {
  const result = plan({
    now: NOW,
    tasks: [task({ id: 'a' }), task({ id: 'b', priority: 1 })],
    availability: fourHours,
  });
  assert.equal(result.explanations.length, 2);
  assert.ok(result.explanations.every((e) => e.because.length > 0));
});

test('a missed deadline is declared, not hidden', () => {
  const result = plan({
    now: NOW,
    tasks: [task({ id: 'big', estimateMin: 600, dueAt: NOW + 2 * H })],
    availability: fourHours,
  });
  const risk = result.risks.find((r) => r.taskId === 'big');
  assert.ok(risk, 'risk must be reported');
  assert.equal(risk!.verdict, 'will_miss');
  assert.ok(risk!.shortfallMinutes > 0);
});

test('a comfortable plan is marked feasible with no risks', () => {
  const result = plan({
    now: NOW,
    tasks: [task({ id: 'a', estimateMin: 60, dueAt: NOW + 7 * 86_400_000 })],
    availability: fourHours,
  });
  assert.equal(result.feasible, true);
  assert.deepEqual(result.risks, []);
  assert.deepEqual(result.unscheduled, []);
});

test('subject budgets sum to total scheduled minutes', () => {
  const result = plan({
    now: NOW,
    tasks: [
      task({ id: 'm1', subjectId: 'maths', estimateMin: 60 }),
      task({ id: 'm2', subjectId: 'maths', estimateMin: 60 }),
      task({ id: 'p1', subjectId: 'physics', estimateMin: 60 }),
    ],
    availability: fourHours,
  });
  const budgetTotal = result.budgets.reduce((s, b) => s + b.minutes, 0);
  const allocTotal = result.allocations.reduce((s, a) => s + a.minutes, 0);
  assert.equal(budgetTotal, allocTotal);
  assert.equal(result.budgets[0].subjectId, 'maths');
  assert.equal(result.budgets[0].minutes, 120);
});

test('long tasks are split into chunks rather than one unbroken stretch', () => {
  const result = plan({
    now: NOW,
    tasks: [task({ id: 'marathon', estimateMin: 240 })],
    availability: fourHours,
    maxChunkMinutes: 60,
  });
  assert.ok(result.allocations.length >= 4, 'should be chunked');
  assert.ok(result.allocations.every((a) => a.minutes <= 60));
});

test('already-logged time reduces what remains to schedule', () => {
  const result = plan({
    now: NOW,
    tasks: [task({ id: 'a', estimateMin: 120, actualMin: 90 })],
    availability: fourHours,
  });
  const total = result.allocations.reduce((s, a) => s + a.minutes, 0);
  assert.equal(total, 30);
});

test('what-if scenarios are comparable and leave the base plan untouched', () => {
  const base = {
    now: NOW,
    tasks: [task({ id: 'a', estimateMin: 300 })],
    availability: fourHours,
  };
  const scenarios = compareScenarios(base, [
    {
      label: 'Add two hours on Saturday',
      patch: { availability: [{ startsAt: NOW, endsAt: NOW + 6 * H }] },
    },
    { label: 'Lose tomorrow', patch: { availability: [] } },
  ]);
  assert.equal(scenarios.length, 3);
  assert.equal(scenarios[0].label, 'Current plan');
  assert.ok(scenarios[1].plan.supplyMinutes > scenarios[0].plan.supplyMinutes);
  assert.equal(scenarios[2].plan.allocations.length, 0);
  assert.equal(scenarios[2].plan.supplyMinutes, 0);
  // The base input must not have been mutated by planning.
  assert.equal(base.availability.length, 1);
});

test('no availability yields an empty but well-formed plan', () => {
  const result = plan({ now: NOW, tasks: [task({ id: 'a' })], availability: [] });
  assert.deepEqual(result.allocations, []);
  assert.equal(result.supplyMinutes, 0);
  assert.equal(result.feasible, false);
  assert.equal(result.unscheduled[0].reason, 'no free time available in this window');
});

test('past availability is ignored', () => {
  const result = plan({
    now: NOW,
    tasks: [task({ id: 'a' })],
    availability: [{ startsAt: NOW - 5 * H, endsAt: NOW - H }],
  });
  assert.equal(result.supplyMinutes, 0);
});

test('a task whose logged time already covers its estimate is not a deadline risk', () => {
  // Regression: remaining work of zero meant the task was never scheduled,
  // and "never scheduled" was being read as "will miss its deadline".
  const result = plan({
    now: NOW,
    tasks: [task({ id: 'covered', estimateMin: 90, actualMin: 95, dueAt: NOW + 2 * 86_400_000 })],
    availability: fourHours,
  });
  assert.deepEqual(result.allocations, []);
  assert.deepEqual(result.risks, [], 'nothing left to do cannot be late');
  assert.equal(result.feasible, true);
});

test('adding disjoint free time increases the supply it reports', () => {
  const base = {
    now: NOW,
    tasks: [task({ id: 'a', estimateMin: 600 })],
    availability: fourHours,
  };
  const before = plan(base);
  const after = plan({
    ...base,
    availability: [...fourHours, { startsAt: NOW + 48 * H, endsAt: NOW + 50 * H }],
  });
  assert.equal(before.supplyMinutes, 240);
  assert.equal(after.supplyMinutes, 360);
});
