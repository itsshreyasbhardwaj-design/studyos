/**
 * Deterministic study planner.
 *
 * Deliberately not an LLM. Scheduling is arithmetic over deadlines, estimates
 * and real free time, so it runs offline, returns the same plan for the same
 * inputs, and can state exactly why one task was placed before another. The
 * AI layer sits *above* this: it proposes estimates and explains plans, but
 * never invents the numbers.
 */

import type { AvailabilityBlock, Exam, Task } from '../types.ts';
import { mergeIntervals, subtractIntervals, type Interval } from '../time/intervals.ts';

const MIN_MS = 60_000;

export interface PlanInput {
  now: number;
  tasks: readonly Task[];
  availability: readonly AvailabilityBlock[];
  /** Minutes of due revision to protect before any task work is scheduled. */
  revisionMinutes?: number;
  exams?: readonly Exam[];
  /** Don't schedule work blocks shorter than this; context switching costs. */
  minChunkMinutes?: number;
  /** Cap on one continuous stretch, so plans include breaks. */
  maxChunkMinutes?: number;
}

export interface Allocation {
  taskId: string;
  /** Undefined for budget-only plans. */
  startsAt?: number;
  endsAt?: number;
  minutes: number;
}

export interface UnscheduledTask {
  taskId: string;
  remainingMinutes: number;
  reason: string;
}

export interface DeadlineRisk {
  taskId: string;
  dueAt: number;
  scheduledCompletionAt?: number;
  shortfallMinutes: number;
  verdict: 'on_track' | 'tight' | 'will_miss';
}

export interface Plan {
  allocations: Allocation[];
  /** Per-subject minute budgets — the "Maths 2h, Physics 1h" view. */
  budgets: Array<{ subjectId: string; minutes: number }>;
  revisionReserved: { startsAt: number; endsAt: number } | null;
  unscheduled: UnscheduledTask[];
  risks: DeadlineRisk[];
  supplyMinutes: number;
  demandMinutes: number;
  feasible: boolean;
  /** Ordered, human-readable justification for the chosen sequence. */
  explanations: Array<{ taskId: string; score: number; because: string }>;
}

/** Dependency-respecting order. Returns cycles instead of hanging or guessing. */
export function orderByDependencies(tasks: readonly Task[]): {
  ordered: Task[];
  cycles: string[][];
} {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 'visiting' | 'done'>();
  const ordered: Task[] = [];
  const cycles: string[][] = [];

  const visit = (task: Task, stack: string[]): void => {
    const current = state.get(task.id);
    if (current === 'done') return;
    if (current === 'visiting') {
      cycles.push([...stack.slice(stack.indexOf(task.id)), task.id]);
      return;
    }
    state.set(task.id, 'visiting');
    for (const depId of task.dependsOn ?? []) {
      const dep = byId.get(depId);
      // A dependency on an unknown or finished task is simply satisfied.
      if (dep && !dep.completedAt) visit(dep, [...stack, task.id]);
    }
    state.set(task.id, 'done');
    ordered.push(task);
  };

  for (const t of tasks) if (!t.completedAt) visit(t, []);
  return { ordered, cycles };
}

/**
 * Urgency score. Earlier deadlines, higher priority, nearer exams and
 * already-started work all push a task up. Pure arithmetic so it is explainable.
 */
export function scoreTask(
  task: Task,
  now: number,
  exams: readonly Exam[] = [],
): { score: number; because: string } {
  const reasons: string[] = [];
  let score = 0;

  // Priority 1 contributes 40, priority 4 contributes 10.
  const priorityPoints = (5 - task.priority) * 10;
  score += priorityPoints;
  reasons.push(`priority ${task.priority}`);

  if (task.dueAt) {
    const daysLeft = (task.dueAt - now) / 86_400_000;
    const remaining = task.estimateMin - (task.actualMin ?? 0);
    // Slack = free days per hour of remaining work. Less slack, more urgent.
    const slack = remaining > 0 ? daysLeft / (remaining / 60) : daysLeft;
    if (daysLeft < 0) {
      score += 120;
      reasons.push(`overdue by ${Math.abs(daysLeft).toFixed(1)}d`);
    } else {
      score += Math.max(0, 60 - slack * 10);
      reasons.push(`due in ${daysLeft.toFixed(1)}d`);
    }
  } else {
    reasons.push('no deadline');
  }

  const exam = exams.find((e) => e.subjectId === task.subjectId && e.startsAt >= now);
  if (exam) {
    const daysToExam = (exam.startsAt - now) / 86_400_000;
    if (daysToExam <= 30) {
      score += (30 - daysToExam) * 1.5;
      reasons.push(`${exam.title} in ${Math.ceil(daysToExam)}d`);
    }
  }

  if ((task.actualMin ?? 0) > 0) {
    score += 5;
    reasons.push('already started');
  }

  return { score, because: reasons.join(' · ') };
}

export function plan(input: PlanInput): Plan {
  const {
    now,
    tasks,
    availability,
    revisionMinutes = 0,
    exams = [],
    minChunkMinutes = 15,
    maxChunkMinutes = 90,
  } = input;

  // Only future, non-fixed time is schedulable.
  const open = mergeIntervals(
    availability
      .filter((b) => !b.fixed && b.endsAt > now)
      .map((b) => ({ startedAt: Math.max(b.startsAt, now), endedAt: b.endsAt })),
  );
  const fixed = availability
    .filter((b) => b.fixed)
    .map((b) => ({ startedAt: b.startsAt, endedAt: b.endsAt }));
  let free = subtractIntervals(open, fixed);

  const supplyMinutes = free.reduce((s, i) => s + (i.endedAt - i.startedAt) / MIN_MS, 0);

  // Revision is protected first: it is time-sensitive in a way task work is not.
  let revisionReserved: Plan['revisionReserved'] = null;
  if (revisionMinutes > 0 && free.length > 0) {
    const taken = takeFromFront(free, revisionMinutes);
    free = taken.remaining;
    if (taken.slices.length > 0) {
      revisionReserved = {
        startsAt: taken.slices[0].startedAt,
        endsAt: taken.slices[taken.slices.length - 1].endedAt,
      };
    }
  }

  const { ordered, cycles } = orderByDependencies(tasks);
  const scored = ordered.map((task) => ({ task, ...scoreTask(task, now, exams) }));

  // Dependencies constrain order; score decides among the ready set. Stable
  // sort on score keeps the topological order as the tie-break.
  const position = new Map(ordered.map((t, i) => [t.id, i]));
  const queue = [...scored].sort(
    (a, b) =>
      dependencyDepth(a.task, tasks) - dependencyDepth(b.task, tasks) ||
      b.score - a.score ||
      position.get(a.task.id)! - position.get(b.task.id)!,
  );

  const allocations: Allocation[] = [];
  const unscheduled: UnscheduledTask[] = [];
  const completionAt = new Map<string, number>();
  let demandMinutes = 0;

  for (const { task } of queue) {
    const remaining = Math.max(0, task.estimateMin - (task.actualMin ?? 0));
    demandMinutes += remaining;
    if (remaining === 0) continue;

    const cycleMember = cycles.some((c) => c.includes(task.id));
    if (cycleMember) {
      unscheduled.push({
        taskId: task.id,
        remainingMinutes: remaining,
        reason: 'circular dependency — resolve the dependency loop to schedule this',
      });
      continue;
    }

    const earliestStart = earliestStartFor(task, completionAt, now);
    const result = allocate(free, remaining, {
      earliestStart,
      minChunkMinutes,
      maxChunkMinutes,
    });
    free = result.remaining;

    for (const slice of result.slices) {
      allocations.push({
        taskId: task.id,
        startsAt: slice.startedAt,
        endsAt: slice.endedAt,
        minutes: (slice.endedAt - slice.startedAt) / MIN_MS,
      });
    }
    if (result.slices.length > 0) {
      completionAt.set(task.id, result.slices[result.slices.length - 1].endedAt);
    }
    if (result.shortfallMinutes > 0) {
      unscheduled.push({
        taskId: task.id,
        remainingMinutes: result.shortfallMinutes,
        reason:
          result.slices.length > 0
            ? 'partially scheduled — not enough free time left for the rest'
            : 'no free time available in this window',
      });
    }
  }

  const risks: DeadlineRisk[] = [];
  for (const { task } of queue) {
    if (!task.dueAt) continue;
    // A task with nothing left to do cannot miss its deadline. Without this,
    // any task whose logged time already covers its estimate is reported as
    // "will miss" purely because it was never scheduled.
    if (Math.max(0, task.estimateMin - (task.actualMin ?? 0)) === 0) continue;
    const finish = completionAt.get(task.id);
    const missing = unscheduled.find((u) => u.taskId === task.id)?.remainingMinutes ?? 0;
    let verdict: DeadlineRisk['verdict'] = 'on_track';
    if (missing > 0 || finish === undefined) verdict = 'will_miss';
    else if (finish > task.dueAt) verdict = 'will_miss';
    else if (task.dueAt - finish < 12 * 3_600_000) verdict = 'tight';
    if (verdict !== 'on_track') {
      risks.push({
        taskId: task.id,
        dueAt: task.dueAt,
        scheduledCompletionAt: finish,
        shortfallMinutes: missing,
        verdict,
      });
    }
  }

  const budgetMap = new Map<string, number>();
  for (const a of allocations) {
    const subject = tasks.find((t) => t.id === a.taskId)?.subjectId ?? 'unassigned';
    budgetMap.set(subject, (budgetMap.get(subject) ?? 0) + a.minutes);
  }

  return {
    allocations,
    budgets: [...budgetMap.entries()]
      .map(([subjectId, minutes]) => ({ subjectId, minutes }))
      .sort((a, b) => b.minutes - a.minutes),
    revisionReserved,
    unscheduled,
    risks,
    supplyMinutes,
    demandMinutes,
    feasible: unscheduled.length === 0 && risks.every((r) => r.verdict !== 'will_miss'),
    explanations: scored.map(({ task, score, because }) => ({
      taskId: task.id,
      score,
      because,
    })),
  };
}

function dependencyDepth(task: Task, tasks: readonly Task[], seen = new Set<string>()): number {
  if (seen.has(task.id)) return 0;
  seen.add(task.id);
  const deps = task.dependsOn ?? [];
  if (deps.length === 0) return 0;
  const depths = deps.map((id) => {
    const dep = tasks.find((t) => t.id === id);
    return dep && !dep.completedAt ? 1 + dependencyDepth(dep, tasks, seen) : 0;
  });
  return Math.max(0, ...depths);
}

function earliestStartFor(
  task: Task,
  completionAt: Map<string, number>,
  now: number,
): number {
  let earliest = now;
  for (const depId of task.dependsOn ?? []) {
    const done = completionAt.get(depId);
    if (done && done > earliest) earliest = done;
  }
  return earliest;
}

interface AllocateOptions {
  earliestStart: number;
  minChunkMinutes: number;
  maxChunkMinutes: number;
}

/** Fill `minutes` from the front of `free`, honouring chunk sizing. */
function allocate(
  free: readonly Interval[],
  minutes: number,
  opts: AllocateOptions,
): { slices: Interval[]; remaining: Interval[]; shortfallMinutes: number } {
  const slices: Interval[] = [];
  const remaining: Interval[] = [];
  let needMs = minutes * MIN_MS;

  for (const block of free) {
    const usableStart = Math.max(block.startedAt, opts.earliestStart);
    const blockMs = block.endedAt - usableStart;

    if (needMs <= 0 || blockMs <= 0) {
      remaining.push(block);
      continue;
    }
    if (usableStart > block.startedAt) {
      remaining.push({ startedAt: block.startedAt, endedAt: usableStart });
    }
    // Don't fragment work into slivers, unless that's all that's left to do.
    if (blockMs < opts.minChunkMinutes * MIN_MS && needMs > blockMs) {
      remaining.push({ startedAt: usableStart, endedAt: block.endedAt });
      continue;
    }

    // Keep taking chunks from this block until it is used up or the task is
    // fully scheduled. Chunk boundaries are where the UI offers a break; the
    // slices themselves stay contiguous so the arithmetic remains exact.
    let cursor = usableStart;
    while (needMs > 0 && cursor < block.endedAt) {
      const availableMs = block.endedAt - cursor;
      if (availableMs < opts.minChunkMinutes * MIN_MS && needMs > availableMs) break;
      const takeMs = Math.min(needMs, availableMs, opts.maxChunkMinutes * MIN_MS);
      if (takeMs <= 0) break;
      slices.push({ startedAt: cursor, endedAt: cursor + takeMs });
      needMs -= takeMs;
      cursor += takeMs;
    }
    if (cursor < block.endedAt) {
      remaining.push({ startedAt: cursor, endedAt: block.endedAt });
    }
  }

  return {
    slices,
    remaining: mergeIntervals(remaining),
    shortfallMinutes: Math.max(0, Math.round(needMs / MIN_MS)),
  };
}

function takeFromFront(
  free: readonly Interval[],
  minutes: number,
): { slices: Interval[]; remaining: Interval[] } {
  const r = allocate(free, minutes, {
    earliestStart: -Infinity,
    minChunkMinutes: 1,
    maxChunkMinutes: Infinity,
  });
  return { slices: r.slices, remaining: r.remaining };
}

/**
 * What-if comparison. Runs the same deterministic planner under altered
 * assumptions so the UI can show consequences without promising outcomes.
 */
export function compareScenarios(
  base: PlanInput,
  variants: Array<{ label: string; patch: Partial<PlanInput> }>,
): Array<{ label: string; plan: Plan }> {
  return [
    { label: 'Current plan', plan: plan(base) },
    ...variants.map((v) => ({ label: v.label, plan: plan({ ...base, ...v.patch }) })),
  ];
}
