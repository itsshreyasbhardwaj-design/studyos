import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessMastery } from '../src/mastery/mastery.ts';
import { DAY_MS } from '../src/revision/fsrs.ts';
import type { PracticeAttempt, RevisionState } from '../src/types.ts';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

function attempts(
  count: number,
  correctCount: number,
  opts: { spreadDays?: number } = {},
): PracticeAttempt[] {
  const spread = opts.spreadDays ?? 1;
  return Array.from({ length: count }, (_, i) => ({
    id: `a${i}`,
    topicId: 'vectors',
    attemptedAt: NOW - (i % spread) * DAY_MS,
    correct: i < correctCount,
  }));
}

function state(o: Partial<RevisionState> = {}): RevisionState {
  return {
    stability: 100,
    difficulty: 5,
    lastReviewedAt: NOW - DAY_MS,
    dueAt: NOW + 50 * DAY_MS,
    reps: 5,
    lapses: 0,
    ...o,
  };
}

test('no evidence means not started', () => {
  const a = assessMastery({ attempts: [], now: NOW });
  assert.equal(a.state, 'not_started');
  assert.match(a.reasons[0], /no graded attempts/);
  assert.ok(a.nextStep.length > 0);
});

test('mastery cannot be reached by study time — the function has no time input', () => {
  // Guards the product's core promise. If a duration parameter is ever added
  // to assessMastery, this test is the thing that should be reconsidered first.
  const signature = assessMastery.toString();
  assert.ok(
    !/minutes|hours|durationMs|studyMs/.test(signature),
    'mastery must not read study duration',
  );
});

test('a few attempts is still learning', () => {
  const a = assessMastery({ attempts: attempts(2, 2), now: NOW });
  assert.equal(a.state, 'learning');
  assert.equal(a.attemptCount, 2);
});

test('mid accuracy over enough attempts is practising', () => {
  const a = assessMastery({ attempts: attempts(8, 5), now: NOW });
  assert.equal(a.state, 'practising');
  assert.ok(a.accuracy! > 0.6 && a.accuracy! < 0.8);
});

test('accuracy below half is a comprehension gap, not a recall gap', () => {
  const a = assessMastery({ attempts: attempts(10, 3), now: NOW });
  assert.equal(a.state, 'learning');
  assert.match(a.reasons.join(' '), /below 50%/);
  assert.match(a.nextStep, /worked example/);
});

test('high accuracy over enough attempts is strong', () => {
  const a = assessMastery({ attempts: attempts(8, 7), now: NOW });
  assert.equal(a.state, 'strong');
});

test('mastery needs high accuracy, volume and a second day', () => {
  const sameDay = assessMastery({ attempts: attempts(12, 12, { spreadDays: 1 }), now: NOW });
  assert.equal(sameDay.state, 'strong', 'one day of answers is not mastery');
  assert.match(sameDay.nextStep, /second day/);

  const twoDays = assessMastery({ attempts: attempts(12, 12, { spreadDays: 3 }), now: NOW });
  assert.equal(twoDays.state, 'mastered');
  assert.ok(twoDays.distinctDays >= 2);
});

test('decayed retention overrides a previously strong record', () => {
  const a = assessMastery({
    attempts: attempts(12, 12, { spreadDays: 3 }),
    revisionStates: [state({ stability: 2, lastReviewedAt: NOW - 60 * DAY_MS })],
    now: NOW,
  });
  assert.equal(a.state, 'needs_revision');
  assert.match(a.reasons.join(' '), /below the 85% floor/);
});

test('an unresolved mistake sends a strong topic back to revision', () => {
  const a = assessMastery({
    attempts: attempts(12, 12, { spreadDays: 3 }),
    openMistakes: 1,
    now: NOW,
  });
  assert.equal(a.state, 'needs_revision');
  assert.match(a.nextStep, /mistake notebook/);
});

test('a recent lapse sends a topic back to revision', () => {
  const a = assessMastery({
    attempts: attempts(12, 12, { spreadDays: 3 }),
    revisionStates: [state({ lapses: 1, lastReviewedAt: NOW - 2 * DAY_MS })],
    now: NOW,
  });
  assert.equal(a.state, 'needs_revision');
  assert.match(a.reasons.join(' '), /lapsed/);
});

test('partial credit scores are honoured over boolean correctness', () => {
  const graded: PracticeAttempt[] = Array.from({ length: 8 }, (_, i) => ({
    id: `g${i}`,
    topicId: 'vectors',
    attemptedAt: NOW - i * DAY_MS,
    correct: true,
    score: 0.6,
  }));
  const a = assessMastery({ attempts: graded, now: NOW });
  assert.ok(Math.abs(a.accuracy! - 0.6) < 1e-9);
  assert.equal(a.state, 'practising');
});

test('every assessment states its evidence and a next step', () => {
  for (const a of [
    assessMastery({ attempts: [], now: NOW }),
    assessMastery({ attempts: attempts(8, 7), now: NOW }),
    assessMastery({ attempts: attempts(12, 12, { spreadDays: 3 }), now: NOW }),
  ]) {
    assert.ok(a.reasons.length > 0, 'no reasons given');
    assert.ok(a.nextStep.length > 0, 'no next step given');
  }
});

test('a topic whose cards are all new is not started, not "needs revision"', () => {
  // Regression: a brand-new card has stability 0, and treating that as 0%
  // recall sent untouched topics straight to "needs revision".
  const a = assessMastery({
    attempts: [],
    revisionStates: [{ stability: 0, difficulty: 5, dueAt: NOW, reps: 0, lapses: 0 }],
    now: NOW,
  });
  assert.equal(a.state, 'not_started');
  assert.equal(a.predictedRetention, undefined);
  assert.doesNotMatch(a.reasons.join(' '), /0%/);
});

test('new cards do not drag down a well-retained topic', () => {
  const a = assessMastery({
    attempts: attempts(12, 12, { spreadDays: 3 }),
    revisionStates: [
      state({ stability: 300, lastReviewedAt: NOW - DAY_MS }),
      { stability: 0, difficulty: 5, dueAt: NOW, reps: 0, lapses: 0 },
    ],
    now: NOW,
  });
  assert.equal(a.state, 'mastered');
  assert.ok(a.predictedRetention! > 0.95);
});
