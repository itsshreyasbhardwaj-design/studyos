import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeIntervals,
  unionDurationMs,
  subtractIntervals,
  findOverlaps,
} from '../src/time/intervals.ts';
import { aggregateEvents, assertWithinWindow, reconstructTimeline } from '../src/time/aggregate.ts';
import type { ActivityEvent } from '../src/types.ts';

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 5, 9, 0, 0);

function ev(p: Partial<ActivityEvent> & Pick<ActivityEvent, 'id' | 'startedAt' | 'endedAt'>): ActivityEvent {
  const span = p.endedAt - p.startedAt;
  return {
    deviceId: 'laptop',
    activeMs: span,
    category: 'deep_study',
    provenance: 'measured',
    ...p,
  };
}

test('mergeIntervals unions overlapping and touching ranges', () => {
  const merged = mergeIntervals([
    { startedAt: 10, endedAt: 20 },
    { startedAt: 15, endedAt: 25 },
    { startedAt: 25, endedAt: 30 },
    { startedAt: 50, endedAt: 60 },
  ]);
  assert.deepEqual(merged, [
    { startedAt: 10, endedAt: 30 },
    { startedAt: 50, endedAt: 60 },
  ]);
});

test('mergeIntervals drops zero and negative length ranges', () => {
  assert.deepEqual(mergeIntervals([{ startedAt: 10, endedAt: 10 }, { startedAt: 30, endedAt: 20 }]), []);
});

test('subtractIntervals carves holes out of the middle', () => {
  const out = subtractIntervals(
    [{ startedAt: 0, endedAt: 100 }],
    [{ startedAt: 30, endedAt: 50 }],
  );
  assert.deepEqual(out, [
    { startedAt: 0, endedAt: 30 },
    { startedAt: 50, endedAt: 100 },
  ]);
});

test('findOverlaps reports concurrent pairs only', () => {
  const pairs = findOverlaps([
    { startedAt: 0, endedAt: 10 },
    { startedAt: 5, endedAt: 15 },
    { startedAt: 20, endedAt: 30 },
  ]);
  assert.equal(pairs.length, 1);
});

test('three devices reporting the same hour yields one hour, not three', () => {
  const events = [
    ev({ id: 'a', deviceId: 'laptop', startedAt: T0, endedAt: T0 + H }),
    ev({ id: 'b', deviceId: 'phone', startedAt: T0, endedAt: T0 + H }),
    ev({ id: 'c', deviceId: 'tablet', startedAt: T0, endedAt: T0 + H }),
  ];
  const totals = aggregateEvents(events, T0, T0 + 24 * H);
  assert.equal(totals.elapsedMs, H, 'elapsed must be a single hour');
  assert.equal(totals.productiveMs, H);
  assert.ok(totals.conflictCount > 0, 'overlap must be reported, not hidden');
  assert.equal(totals.conflictMs, H);
  assertWithinWindow(totals, T0, T0 + 24 * H);
});

test('category and subject breakdowns sum exactly to elapsed time', () => {
  const events = [
    ev({ id: 'a', startedAt: T0, endedAt: T0 + H, subjectId: 'maths', category: 'deep_study' }),
    ev({ id: 'b', startedAt: T0 + H, endedAt: T0 + 2 * H, subjectId: 'physics', category: 'practice' }),
    ev({ id: 'c', startedAt: T0 + 2 * H, endedAt: T0 + 2.5 * H, category: 'break' }),
    // Overlaps 'b' from a second device with a different subject.
    ev({ id: 'd', deviceId: 'phone', startedAt: T0 + 1.5 * H, endedAt: T0 + 2 * H, subjectId: 'maths' }),
  ];
  const totals = aggregateEvents(events, T0, T0 + 24 * H);
  const catSum = Object.values(totals.byCategory).reduce((a, b) => a + b, 0);
  assert.equal(catSum, totals.elapsedMs, 'categories must partition elapsed time');
  const devSum = Object.values(totals.byDevice).reduce((a, b) => a + b, 0);
  assert.equal(devSum, totals.elapsedMs, 'devices must partition elapsed time');
  assert.equal(totals.elapsedMs, 2.5 * H);
});

test('a human correction outranks a device measurement for the same slice', () => {
  const events = [
    ev({ id: 'measured', startedAt: T0, endedAt: T0 + H, category: 'deep_study', provenance: 'measured' }),
    ev({ id: 'corrected', deviceId: 'web', startedAt: T0, endedAt: T0 + H, category: 'distraction', provenance: 'confirmed' }),
  ];
  const totals = aggregateEvents(events, T0, T0 + 24 * H);
  assert.equal(totals.distractionMs, H, 'the user said this was distraction');
  assert.equal(totals.productiveMs, 0);
});

test('idle time is excluded from active but kept in elapsed', () => {
  const events = [ev({ id: 'a', startedAt: T0, endedAt: T0 + H, activeMs: H / 2 })];
  const totals = aggregateEvents(events, T0, T0 + 24 * H);
  assert.equal(totals.elapsedMs, H);
  assert.equal(totals.activeMs, H / 2);
});

test('events are clipped to the requested window', () => {
  const events = [ev({ id: 'a', startedAt: T0 - 2 * H, endedAt: T0 + H })];
  const totals = aggregateEvents(events, T0, T0 + 24 * H);
  assert.equal(totals.elapsedMs, H);
});

test('empty input produces zeroed totals, not NaN', () => {
  const totals = aggregateEvents([], T0, T0 + H);
  assert.equal(totals.elapsedMs, 0);
  assert.equal(totals.activeMs, 0);
  assert.deepEqual(totals.byCategory, {});
});

test('timeline collapses contiguous same-subject runs and records both devices', () => {
  const events = [
    ev({ id: 'a', startedAt: T0, endedAt: T0 + H, subjectId: 'maths' }),
    ev({ id: 'b', deviceId: 'phone', startedAt: T0 + H, endedAt: T0 + 2 * H, subjectId: 'maths' }),
    ev({ id: 'c', startedAt: T0 + 2 * H, endedAt: T0 + 3 * H, subjectId: 'physics' }),
  ];
  const blocks = reconstructTimeline(events, T0, T0 + 24 * H);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].endedAt - blocks[0].startedAt, 2 * H);
  assert.deepEqual(blocks[0].deviceIds, ['laptop', 'phone']);
});
