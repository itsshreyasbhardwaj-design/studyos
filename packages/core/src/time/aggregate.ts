import type { ActivityEvent, ActivityCategory, Provenance } from '../types.ts';
import { PRODUCTIVE_CATEGORIES } from '../types.ts';
import { clipInterval, findOverlaps, unionDurationMs, type Interval } from './intervals.ts';

/**
 * Precedence used when two devices claim the same millisecond. A human
 * correction always beats a measurement, which always beats a guess.
 */
const PROVENANCE_RANK: Record<Provenance, number> = {
  confirmed: 4,
  demonstrated: 3,
  measured: 2,
  inferred: 1,
};

export interface TimeTotals {
  /** Wall-clock ms covered by at least one event. Never exceeds the window. */
  elapsedMs: number;
  /** Ms of recorded interaction, overlap-adjusted. */
  activeMs: number;
  /** Ms in categories that count as productive study. */
  productiveMs: number;
  breakMs: number;
  distractionMs: number;
  byCategory: Record<string, number>;
  bySubject: Record<string, number>;
  byDevice: Record<string, number>;
  /**
   * Slices where two or more events disagreed. Non-zero means the elapsed
   * total is trustworthy but the *attribution* involved a tie-break, so the
   * UI shows a "review overlaps" prompt rather than presenting it as clean.
   */
  conflictCount: number;
  conflictMs: number;
}

/**
 * Aggregate events over `[from, to)` without double-counting.
 *
 * Each elementary time slice is attributed to exactly one event, so the
 * per-category and per-subject breakdowns sum to `elapsedMs` exactly. Active
 * time within a retained slice is pro-rated from the event's reported
 * `activeMs`; that pro-rating is an estimate and is why `activeMs` is
 * reported as `inferred` by `summarise()` whenever any overlap existed.
 */
export function aggregateEvents(
  events: readonly ActivityEvent[],
  from: number,
  to: number,
): TimeTotals {
  const totals: TimeTotals = {
    elapsedMs: 0,
    activeMs: 0,
    productiveMs: 0,
    breakMs: 0,
    distractionMs: 0,
    byCategory: {},
    bySubject: {},
    byDevice: {},
    conflictCount: 0,
    conflictMs: 0,
  };

  const clipped = events
    .map((e) => {
      const window = clipInterval({ startedAt: e.startedAt, endedAt: e.endedAt }, from, to);
      return window ? { event: e, ...window } : null;
    })
    .filter((x): x is { event: ActivityEvent } & Interval => x !== null);

  if (clipped.length === 0) return totals;

  const overlaps = findOverlaps(clipped);
  totals.conflictCount = overlaps.length;

  // Sweep line over every boundary, so each slice has a stable winner set.
  const boundaries = [...new Set(clipped.flatMap((c) => [c.startedAt, c.endedAt]))].sort(
    (a, b) => a - b,
  );

  for (let i = 0; i < boundaries.length - 1; i++) {
    const sliceStart = boundaries[i];
    const sliceEnd = boundaries[i + 1];
    const sliceMs = sliceEnd - sliceStart;
    if (sliceMs <= 0) continue;

    const covering = clipped.filter((c) => c.startedAt <= sliceStart && c.endedAt >= sliceEnd);
    if (covering.length === 0) continue;
    if (covering.length > 1) totals.conflictMs += sliceMs;

    const winner = covering.reduce((best, cur) => {
      const rank = PROVENANCE_RANK[cur.event.provenance] - PROVENANCE_RANK[best.event.provenance];
      if (rank !== 0) return rank > 0 ? cur : best;
      // Tie-break deterministically so the same data always totals the same.
      const curDensity = density(cur.event);
      const bestDensity = density(best.event);
      if (curDensity !== bestDensity) return curDensity > bestDensity ? cur : best;
      return cur.event.id < best.event.id ? cur : best;
    });

    const e = winner.event;
    totals.elapsedMs += sliceMs;
    totals.activeMs += Math.min(sliceMs, Math.round(density(e) * sliceMs));
    bump(totals.byCategory, e.category, sliceMs);
    bump(totals.byDevice, e.deviceId, sliceMs);
    if (e.subjectId) bump(totals.bySubject, e.subjectId, sliceMs);

    if (PRODUCTIVE_CATEGORIES.has(e.category)) totals.productiveMs += sliceMs;
    else if (e.category === 'break') totals.breakMs += sliceMs;
    else if (e.category === 'distraction') totals.distractionMs += sliceMs;
  }

  return totals;
}

/** Fraction of an event's window that was active interaction, clamped to [0,1]. */
function density(e: ActivityEvent): number {
  const span = e.endedAt - e.startedAt;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(1, e.activeMs / span));
}

function bump(record: Record<string, number>, key: string, ms: number): void {
  record[key] = (record[key] ?? 0) + ms;
}

/**
 * Rebuild a readable timeline: contiguous runs of the same category/subject
 * collapsed into blocks. Used by the Universal Study Timeline view.
 */
export interface TimelineBlock extends Interval {
  category: ActivityCategory;
  subjectId?: string;
  deviceIds: string[];
  provenance: Provenance;
}

export function reconstructTimeline(
  events: readonly ActivityEvent[],
  from: number,
  to: number,
): TimelineBlock[] {
  const sorted = events
    .map((e) => {
      const w = clipInterval({ startedAt: e.startedAt, endedAt: e.endedAt }, from, to);
      return w ? { ...e, ...w } : null;
    })
    .filter((x): x is ActivityEvent & Interval => x !== null)
    .sort((a, b) => a.startedAt - b.startedAt);

  const blocks: TimelineBlock[] = [];
  for (const e of sorted) {
    const last = blocks[blocks.length - 1];
    const continues =
      last &&
      last.category === e.category &&
      last.subjectId === e.subjectId &&
      e.startedAt <= last.endedAt;
    if (continues) {
      last.endedAt = Math.max(last.endedAt, e.endedAt);
      if (!last.deviceIds.includes(e.deviceId)) last.deviceIds.push(e.deviceId);
      if (PROVENANCE_RANK[e.provenance] > PROVENANCE_RANK[last.provenance]) {
        last.provenance = e.provenance;
      }
    } else {
      blocks.push({
        startedAt: e.startedAt,
        endedAt: e.endedAt,
        category: e.category,
        subjectId: e.subjectId,
        deviceIds: [e.deviceId],
        provenance: e.provenance,
      });
    }
  }
  return blocks;
}

/** Sanity ceiling: recorded time can never exceed the window it sits in. */
export function assertWithinWindow(totals: TimeTotals, from: number, to: number): void {
  const windowMs = to - from;
  if (totals.elapsedMs > windowMs) {
    throw new Error(
      `aggregate produced ${totals.elapsedMs}ms inside a ${windowMs}ms window — overlap handling is broken`,
    );
  }
}

export { unionDurationMs };
