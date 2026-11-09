import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calibrate,
  replay,
  fitStabilityScale,
  applyReview,
  retrievability,
  DEFAULT_PARAMS,
  DAY_MS,
  MIN_REVIEWS_TO_FIT,
  MIN_LAPSES_TO_FIT,
  type ReviewRecord,
  type ReviewGrade,
  type FsrsParams,
  type RevisionState,
} from '../src/index.ts';

const T0 = Date.UTC(2026, 0, 1);

function review(cardId: string, day: number, grade: ReviewGrade): ReviewRecord {
  return { cardId, reviewedAt: T0 + day * DAY_MS, grade };
}

/** Deterministic PRNG, so a "simulated learner" test is reproducible. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * Simulate a learner whose memory is `trueScale` times as durable as the
 * shipped model estimates, reviewed whenever that model says they are due.
 *
 * This is exactly what a real user generates: a log whose gaps were chosen by
 * the uncorrected scheduler, recorded from someone the scheduler is wrong
 * about. The fitter has to recover `trueScale` from that, which is harder
 * than recovering it from freely chosen gaps.
 */
function simulate(options: {
  cards: number;
  reviewsPerCard: number;
  trueScale: number;
  seed: number;
}): ReviewRecord[] {
  const random = rng(options.seed);
  const log: ReviewRecord[] = [];

  for (let c = 0; c < options.cards; c += 1) {
    const cardId = `card-${c}`;
    let state: RevisionState | undefined;
    let at = T0 + Math.floor(random() * 5) * DAY_MS;

    for (let r = 0; r < options.reviewsPerCard; r += 1) {
      let grade: ReviewGrade;
      if (!state) {
        grade = 3;
      } else {
        const elapsed = (at - (state.lastReviewedAt ?? at)) / DAY_MS;
        const trueRecall = retrievability(elapsed, state.stability * options.trueScale);
        grade = random() < trueRecall ? 3 : 1;
      }
      log.push({ cardId, reviewedAt: at, grade });
      const next = applyReview(state, grade, at, DEFAULT_PARAMS);
      state = next.state;
      at += Math.max(1, next.intervalDays) * DAY_MS;
    }
  }
  return log;
}

test('a card\'s first review is not scored — there was nothing to predict from', () => {
  const log = [review('a', 0, 3), review('a', 10, 3), review('b', 0, 3)];
  const { scored, excluded } = replay(log);
  assert.equal(scored.length, 1);
  assert.equal(excluded.firstReview, 2);
  assert.equal(scored[0].cardId, 'a');
});

test('same-day repeats are excluded rather than scored as near-certain hits', () => {
  const log = [review('a', 0, 3), review('a', 0, 3), review('a', 20, 3)];
  const { scored, excluded } = replay(log);
  assert.equal(excluded.sameDay, 1);
  assert.equal(scored.length, 1, 'only the review after a real gap is scored');
  assert.ok(scored[0].elapsedDays >= 1);
});

test('a same-day repeat is unscored but not discarded', () => {
  // FSRS-4.5 holds stability across a same-day repeat and lets difficulty
  // absorb it, so the very next prediction is unchanged by design. The repeat
  // still has to reach the state, which shows up one review later: difficulty
  // feeds stability growth at the next real review.
  const withRepeat = replay([
    review('a', 0, 3), review('a', 0, 1), review('a', 30, 3), review('a', 90, 3),
  ]);
  const without = replay([review('a', 0, 3), review('a', 30, 3), review('a', 90, 3)]);

  assert.equal(
    withRepeat.scored[0].predicted,
    without.scored[0].predicted,
    'stability is held across a same-day repeat, so the next prediction matches',
  );
  assert.notEqual(
    withRepeat.scored[1].predicted,
    without.scored[1].predicted,
    'but the repeat moved difficulty, which must reach the following review',
  );
});

test('predictions come from a replay, not from what was stored at the time', () => {
  const log = [review('a', 0, 3), review('a', 15, 3)];
  const soft = replay(log, { ...DEFAULT_PARAMS, stabilityScale: 0.5 });
  const firm = replay(log, { ...DEFAULT_PARAMS, stabilityScale: 2 });
  assert.ok(
    soft.scored[0].predicted < firm.scored[0].predicted,
    'a less durable learner must be predicted to recall less after the same gap',
  );
});

test('a perfectly predicted log scores better than a surprising one', () => {
  // Long gaps then failures: the model expected recall and did not get it.
  const surprising = calibrate([
    review('a', 0, 3), review('a', 5, 1),
    review('b', 0, 3), review('b', 5, 1),
    review('c', 0, 3), review('c', 5, 1),
  ]);
  const expected = calibrate([
    review('a', 0, 3), review('a', 5, 3),
    review('b', 0, 3), review('b', 5, 3),
    review('c', 0, 3), review('c', 5, 3),
  ]);
  assert.ok(surprising.logLoss > expected.logLoss);
  assert.ok(surprising.brier > expected.brier);
  assert.equal(surprising.lapses, 3);
  assert.equal(expected.lapses, 0);
});

test('no verdict is given on a sample too small to support one', () => {
  const c = calibrate([review('a', 0, 3), review('a', 5, 1)]);
  assert.equal(c.verdict, 'insufficient');
  assert.ok(c.scored < 30);
  assert.ok(c.logLoss > 0, 'the measurement is still reported, only the verdict withheld');
});

test('an empty log reports nothing rather than dividing by zero', () => {
  const c = calibrate([]);
  assert.equal(c.scored, 0);
  assert.equal(c.verdict, 'insufficient');
  assert.ok(Number.isFinite(c.logLoss) && Number.isFinite(c.brier));
  assert.deepEqual(c.buckets, []);
});

test('a learner who forgets faster than the model reads as overconfident', () => {
  const log = simulate({ cards: 40, reviewsPerCard: 8, trueScale: 0.45, seed: 7 });
  const c = calibrate(log);
  assert.equal(c.verdict, 'overconfident');
  assert.ok(c.meanPredicted > c.meanObserved);
});

test('a learner the defaults describe well reads as indistinguishable', () => {
  const log = simulate({ cards: 40, reviewsPerCard: 8, trueScale: 1, seed: 11 });
  const c = calibrate(log);
  assert.equal(c.verdict, 'indistinguishable');
});

test('buckets partition the scored reviews exactly once', () => {
  const log = simulate({ cards: 30, reviewsPerCard: 6, trueScale: 0.6, seed: 3 });
  const c = calibrate(log);
  assert.equal(
    c.buckets.reduce((sum, b) => sum + b.count, 0),
    c.scored,
    'every scored review belongs to exactly one bucket',
  );
  for (const b of c.buckets) {
    assert.ok(b.predicted >= b.from && b.predicted <= b.to, 'bucket mean sits in its own range');
    assert.ok(b.observed >= 0 && b.observed <= 1);
  }
});

test('the fitter recovers a planted correction', () => {
  const log = simulate({ cards: 80, reviewsPerCard: 10, trueScale: 0.5, seed: 21 });
  const fit = fitStabilityScale(log);
  assert.equal(fit.fitted, true, fit.reason);
  assert.ok(fit.scale < 1, `fitted ${fit.scale.toFixed(3)}: must find the right direction`);
  assert.ok(
    fit.scale > 0.4 && fit.scale < 0.85,
    `fitted ${fit.scale.toFixed(3)}: biased toward 1 by the scheduler's own gaps, but not past 0.85`,
  );
  assert.ok(fit.logLossAfter < fit.logLossBefore, 'the fit must explain the log better');
  assert.ok(fit.interval && fit.interval[0] < fit.scale && fit.interval[1] > fit.scale);
  assert.equal(fit.includesDefault, false);
});

test('the planted truth lies inside the reported interval', () => {
  for (const trueScale of [0.4, 0.5, 0.6]) {
    const fit = fitStabilityScale(
      simulate({ cards: 80, reviewsPerCard: 10, trueScale, seed: 21 }),
    );
    assert.ok(fit.interval, `no interval for ${trueScale}`);
    const [lo, hi] = fit.interval!;
    assert.ok(
      trueScale >= lo && trueScale <= hi,
      `truth ${trueScale} outside [${lo.toFixed(2)}, ${hi.toFixed(2)}] — the interval is lying`,
    );
  }
});

test('fitting improves calibration rather than just the number it optimised', () => {
  const log = simulate({ cards: 80, reviewsPerCard: 10, trueScale: 0.5, seed: 21 });
  const fit = fitStabilityScale(log);
  const after = calibrate(log, { ...DEFAULT_PARAMS, stabilityScale: fit.scale });
  const before = calibrate(log);
  assert.ok(
    Math.abs(after.meanPredicted - after.meanObserved) <
      Math.abs(before.meanPredicted - before.meanObserved),
    'predicted and observed recall must move closer together',
  );
  assert.ok(after.logLoss < before.logLoss);
});

test('the defaults are left alone when they already fit', () => {
  const log = simulate({ cards: 80, reviewsPerCard: 10, trueScale: 1, seed: 5 });
  const fit = fitStabilityScale(log);
  assert.equal(fit.fitted, false);
  assert.equal(fit.includesDefault, true);
  assert.match(fit.reason ?? '', /already describe/);
  assert.ok(fit.interval && fit.interval[0] <= 1 && fit.interval[1] >= 1);
});

test('a thin log is refused with the count it needs, not a fitted guess', () => {
  const log = simulate({ cards: 5, reviewsPerCard: 4, trueScale: 0.5, seed: 9 });
  const fit = fitStabilityScale(log);
  assert.equal(fit.fitted, false);
  assert.equal(fit.scale, 1);
  assert.match(fit.reason ?? '', new RegExp(String(MIN_REVIEWS_TO_FIT)));
  assert.ok(fit.scored < MIN_REVIEWS_TO_FIT);
});

test('a log with enough reviews but too few lapses is refused on the lapses', () => {
  // A learner who never forgets: plenty of reviews, almost no information
  // about the shape of the decay curve.
  const log = simulate({ cards: 60, reviewsPerCard: 10, trueScale: 8, seed: 13 });
  const fit = fitStabilityScale(log);
  assert.equal(fit.fitted, false);
  assert.ok(fit.scored >= MIN_REVIEWS_TO_FIT, 'the total was not the problem');
  assert.ok(fit.lapses < MIN_LAPSES_TO_FIT);
  assert.match(fit.reason ?? '', /lapses/);
});

test('fitting is deterministic — the same log gives the same answer', () => {
  const log = simulate({ cards: 80, reviewsPerCard: 10, trueScale: 0.6, seed: 2 });
  const a = fitStabilityScale(log);
  const b = fitStabilityScale([...log].reverse());
  assert.equal(a.scale, b.scale, 'input order must not change the fit');
  assert.deepEqual(a.weights, b.weights);
});

test('a fitted scale shortens intervals as well as predictions', () => {
  // The correction has to change what the scheduler *does*, not only what it
  // reports, or a learner who forgets faster still gets the same long gaps.
  const after4 = applyReview(undefined, 3, T0, DEFAULT_PARAMS);
  const second = applyReview(after4.state, 3, T0 + 5 * DAY_MS, DEFAULT_PARAMS);
  const secondCorrected = applyReview(after4.state, 3, T0 + 5 * DAY_MS, {
    ...DEFAULT_PARAMS,
    stabilityScale: 0.5,
  });
  assert.ok(
    secondCorrected.intervalDays < second.intervalDays,
    'a less durable learner must be scheduled sooner',
  );
  assert.ok(
    secondCorrected.retrievabilityAtReview < second.retrievabilityAtReview,
    'and be modelled as having recalled less',
  );
});

test('a same-day repeat is still excluded once a scale is applied', () => {
  const log = [review('a', 0, 3), review('a', 0, 3), review('a', 20, 3)];
  const { excluded } = replay(log, { ...DEFAULT_PARAMS, stabilityScale: 0.4 });
  assert.equal(excluded.sameDay, 1);
});
