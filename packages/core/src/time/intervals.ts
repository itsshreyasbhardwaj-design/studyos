/**
 * Interval algebra for the tracking engine.
 *
 * Why this exists: a user can study with a desktop tracker, a browser
 * extension and a phone all reporting at once. Summing their durations
 * triple-counts the same hour. Every aggregate total in StudyOS is computed
 * over the *union* of intervals, so wall-clock totals can never exceed
 * wall-clock time.
 */

export interface Interval {
  startedAt: number;
  endedAt: number;
}

/** Sorted, non-overlapping, non-adjacent-touching union of the inputs. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const valid = intervals
    .filter((i) => i.endedAt > i.startedAt)
    .sort((a, b) => a.startedAt - b.startedAt);
  const out: Interval[] = [];
  for (const cur of valid) {
    const last = out[out.length - 1];
    if (last && cur.startedAt <= last.endedAt) {
      if (cur.endedAt > last.endedAt) last.endedAt = cur.endedAt;
    } else {
      out.push({ startedAt: cur.startedAt, endedAt: cur.endedAt });
    }
  }
  return out;
}

/** Wall-clock milliseconds covered by at least one interval. */
export function unionDurationMs(intervals: readonly Interval[]): number {
  return mergeIntervals(intervals).reduce((sum, i) => sum + (i.endedAt - i.startedAt), 0);
}

/** Pairs of intervals that overlap — surfaced to the user for correction. */
export function findOverlaps<T extends Interval>(intervals: readonly T[]): Array<[T, T]> {
  const sorted = [...intervals].sort((a, b) => a.startedAt - b.startedAt);
  const pairs: Array<[T, T]> = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].startedAt >= sorted[i].endedAt) break;
      pairs.push([sorted[i], sorted[j]]);
    }
  }
  return pairs;
}

/** The part of `interval` inside `[from, to)`, or null if disjoint. */
export function clipInterval(interval: Interval, from: number, to: number): Interval | null {
  const startedAt = Math.max(interval.startedAt, from);
  const endedAt = Math.min(interval.endedAt, to);
  return endedAt > startedAt ? { startedAt, endedAt } : null;
}

/** Subtract `holes` from `base`, used to exclude breaks and private windows. */
export function subtractIntervals(
  base: readonly Interval[],
  holes: readonly Interval[],
): Interval[] {
  const merged = mergeIntervals(holes);
  let acc = mergeIntervals(base);
  for (const hole of merged) {
    const next: Interval[] = [];
    for (const piece of acc) {
      if (hole.endedAt <= piece.startedAt || hole.startedAt >= piece.endedAt) {
        next.push(piece);
        continue;
      }
      if (hole.startedAt > piece.startedAt) {
        next.push({ startedAt: piece.startedAt, endedAt: hole.startedAt });
      }
      if (hole.endedAt < piece.endedAt) {
        next.push({ startedAt: hole.endedAt, endedAt: piece.endedAt });
      }
    }
    acc = next;
  }
  return acc;
}
