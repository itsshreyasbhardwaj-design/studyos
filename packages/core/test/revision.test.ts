import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyReview,
  retrievability,
  intervalForRetention,
  initialDifficulty,
  previewIntervals,
  DAY_MS,
  DEFAULT_PARAMS,
  MAX_STABILITY,
} from '../src/revision/fsrs.ts';
import { buildQueue, interleave, type RevisionCard } from '../src/revision/queue.ts';
import { forgetfulnessRadar } from '../src/revision/radar.ts';
import type { ReviewGrade, RevisionState } from '../src/types.ts';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

test('retrievability is exactly 0.9 when elapsed time equals stability', () => {
  // This is the defining property of the FSRS FACTOR/DECAY pair. If this
  // drifts, every scheduled interval in the product is wrong.
  for (const s of [0.5, 1, 7, 30, 365]) {
    assert.ok(Math.abs(retrievability(s, s) - 0.9) < 1e-12, `S=${s}`);
  }
});

test('retrievability decays monotonically and stays in (0,1]', () => {
  let prev = retrievability(0, 10);
  assert.equal(prev, 1);
  for (let t = 1; t <= 400; t++) {
    const r = retrievability(t, 10);
    assert.ok(r < prev, `not decreasing at t=${t}`);
    assert.ok(r > 0 && r <= 1, `out of range at t=${t}`);
    prev = r;
  }
});

test('intervalForRetention inverts retrievability', () => {
  for (const s of [1, 10, 100]) {
    for (const r of [0.95, 0.9, 0.8, 0.7]) {
      const days = intervalForRetention(s, r);
      assert.ok(Math.abs(retrievability(days, s) - r) < 1e-9, `S=${s} r=${r}`);
    }
  }
});

test('a lower desired retention schedules a longer gap', () => {
  const strict = intervalForRetention(10, 0.95);
  const relaxed = intervalForRetention(10, 0.8);
  assert.ok(relaxed > strict);
});

test('first review: better grades give longer intervals', () => {
  const p = previewIntervals(undefined, NOW);
  assert.ok(p[4] > p[3], 'Easy must beat Good');
  assert.ok(p[3] > p[2], 'Good must beat Hard');
  assert.ok(p[2] >= p[1], 'Hard must not be shorter than Again');
  assert.ok(p[1] >= 1, 'minimum interval is one day');
});

test('first review: Easy is easier than Again on the difficulty scale', () => {
  assert.ok(initialDifficulty(4) < initialDifficulty(1));
  for (const g of [1, 2, 3, 4] as ReviewGrade[]) {
    const d = initialDifficulty(g);
    assert.ok(d >= 1 && d <= 10, `difficulty out of range for grade ${g}`);
  }
});

test('a lapse never increases stability on a mature card', () => {
  const mature: RevisionState = {
    stability: 60,
    difficulty: 5,
    lastReviewedAt: NOW - 60 * DAY_MS,
    dueAt: NOW,
    reps: 8,
    lapses: 0,
  };
  const after = applyReview(mature, 1, NOW);
  assert.ok(after.state.stability <= mature.stability, 'forgetting must not strengthen memory');
  assert.equal(after.state.lapses, 1);
  assert.ok(after.intervalDays >= 1);
});

test('successful recall increases stability', () => {
  const card: RevisionState = {
    stability: 10,
    difficulty: 5,
    lastReviewedAt: NOW - 10 * DAY_MS,
    dueAt: NOW,
    reps: 3,
    lapses: 0,
  };
  const good = applyReview(card, 3, NOW);
  assert.ok(good.state.stability > card.stability);
  assert.ok(Math.abs(good.retrievabilityAtReview - 0.9) < 1e-9, 'reviewed exactly on schedule');
});

test('difficulty and stability stay inside their bounds under 500 random reviews', () => {
  let state: RevisionState | undefined;
  let at = NOW;
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 500; i++) {
    const grade = (1 + Math.floor(rand() * 4)) as ReviewGrade;
    const out = applyReview(state, grade, at);
    state = out.state;
    assert.ok(state.difficulty >= 1 && state.difficulty <= 10, `D=${state.difficulty} at i=${i}`);
    assert.ok(state.stability > 0 && state.stability <= MAX_STABILITY, `S=${state.stability}`);
    assert.ok(Number.isFinite(out.intervalDays) && out.intervalDays >= 1);
    assert.ok(out.intervalDays <= DEFAULT_PARAMS.maximumInterval);
    at = state.dueAt;
  }
});

test('repeated Again does not inflate stability', () => {
  let state = applyReview(undefined, 3, NOW).state;
  const start = state.stability;
  let at = NOW;
  for (let i = 0; i < 5; i++) {
    at += 1 * DAY_MS;
    state = applyReview(state, 1, at).state;
  }
  assert.ok(state.stability <= start * 1.5, `runaway stability: ${state.stability} from ${start}`);
  assert.equal(state.lapses, 5);
});

test('same-day repeat holds long-term stability instead of inventing growth', () => {
  const first = applyReview(undefined, 3, NOW).state;
  const sameDay = applyReview(first, 3, NOW + 3_600_000);
  assert.equal(sameDay.state.stability, first.stability);
  assert.equal(sameDay.state.reps, 2);
});

// ---- queue ----

function card(id: string, subjectId: string, overrides: Partial<RevisionState> = {}): RevisionCard {
  return {
    id,
    topicId: `topic-${id}`,
    subjectId,
    state: {
      stability: 10,
      difficulty: 5,
      lastReviewedAt: NOW - 11 * DAY_MS,
      dueAt: NOW - DAY_MS,
      reps: 2,
      lapses: 0,
      ...overrides,
    },
  };
}

test('queue serves only due cards and reports the rest as backlog', () => {
  const cards = [
    card('a', 'maths'),
    card('b', 'maths'),
    card('c', 'physics'),
    card('future', 'physics', { dueAt: NOW + 5 * DAY_MS }),
  ];
  const q = buildQueue(cards, { now: NOW, limit: 2 });
  assert.equal(q.cards.length, 2);
  assert.equal(q.backlogCount, 1, 'three due, two served');
  assert.equal(q.backlogSessions, 2);
  assert.ok(!q.cards.some((c) => c.id === 'future'), 'future cards must not be served');
});

test('queue prioritises an imminent exam over an equally-due other subject', () => {
  const cards = [card('maths-1', 'maths'), card('art-1', 'art')];
  const q = buildQueue(cards, {
    now: NOW,
    limit: 2,
    examDates: { maths: NOW + 3 * DAY_MS },
  });
  assert.equal(q.cards[0].subjectId, 'maths');
  assert.match(q.cards[0].reason, /exam in \d+d/);
});

test('a logged mistake raises a card up the queue', () => {
  const plain = card('plain', 'maths');
  const flagged = { ...card('flagged', 'maths'), flaggedByMistake: true };
  const q = buildQueue([plain, flagged], { now: NOW, limit: 2 });
  assert.equal(q.cards[0].id, 'flagged');
  assert.match(q.cards[0].reason, /recent mistake/);
});

test('every served card states why it was chosen', () => {
  const q = buildQueue([card('a', 'maths')], { now: NOW, limit: 5 });
  assert.ok(q.cards[0].reason.length > 0);
  assert.ok(q.cards[0].predictedRetention > 0 && q.cards[0].predictedRetention < 1);
});

test('interleaving breaks up long single-subject runs', () => {
  const cards = [
    ...Array.from({ length: 6 }, (_, i) => ({ subjectId: 'maths', id: `m${i}` })),
    ...Array.from({ length: 3 }, (_, i) => ({ subjectId: 'physics', id: `p${i}` })),
  ];
  const out = interleave(cards, 2);
  assert.equal(out.length, 9, 'no cards may be lost');
  let run = 1;
  let worst = 1;
  for (let i = 1; i < out.length; i++) {
    run = out[i].subjectId === out[i - 1].subjectId ? run + 1 : 1;
    worst = Math.max(worst, run);
  }
  // Once the smaller subject is exhausted the remainder must run on, so the
  // cap applies while a choice exists.
  assert.ok(worst <= 4, `run of ${worst} is too long while alternatives existed`);
});

test('interleaving a single subject keeps every card', () => {
  const cards = Array.from({ length: 5 }, (_, i) => ({ subjectId: 'maths', id: `m${i}` }));
  assert.equal(interleave(cards, 2).length, 5);
});

// ---- radar ----

test('radar ranks a decayed topic above a freshly reviewed one', () => {
  const decayed = card('old', 'maths', {
    stability: 2,
    lastReviewedAt: NOW - 60 * DAY_MS,
    lapses: 3,
  });
  const fresh = card('new', 'maths', { stability: 50, lastReviewedAt: NOW - DAY_MS });
  const rows = forgetfulnessRadar([decayed, fresh], NOW);
  assert.equal(rows[0].topicId, 'topic-old');
  assert.ok(rows[0].predictedRetention < rows[1].predictedRetention);
  assert.match(rows[0].reason, /modelled recall/);
  assert.match(rows[0].reason, /lapse/);
});

test('radar groups cards by topic and counts them', () => {
  const rows = forgetfulnessRadar(
    [
      { ...card('a', 'maths'), topicId: 'vectors' },
      { ...card('b', 'maths'), topicId: 'vectors' },
      { ...card('c', 'maths'), topicId: 'calculus' },
    ],
    NOW,
  );
  const vectors = rows.find((r) => r.topicId === 'vectors');
  assert.equal(vectors?.cardCount, 2);
  assert.equal(rows.length, 2);
});

test('radar weights an upcoming exam into the risk score', () => {
  const c = card('a', 'maths');
  const without = forgetfulnessRadar([c], NOW)[0];
  const with_ = forgetfulnessRadar([c], NOW, { maths: NOW + 5 * DAY_MS })[0];
  assert.ok(with_.risk > without.risk);
  assert.match(with_.reason, /assessed in 5 days/);
});

// ---- new cards must not be reported as forgotten ----

test('a never-reviewed card reports no retention rather than 0%', () => {
  const brandNew: RevisionCard = {
    id: 'new',
    topicId: 'topic-new',
    subjectId: 'maths',
    state: { stability: 0, difficulty: 5, dueAt: NOW - 1000, reps: 0, lapses: 0 },
  };
  const q = buildQueue([brandNew], { now: NOW, limit: 5 });
  assert.equal(q.cards.length, 1);
  assert.equal(q.cards[0].isNew, true);
  assert.equal(
    q.cards[0].predictedRetention,
    undefined,
    '"never studied" and "completely forgotten" are different claims',
  );
  assert.match(q.cards[0].reason, /new card, never reviewed/);
  assert.doesNotMatch(q.cards[0].reason, /0%/);
  assert.doesNotMatch(q.cards[0].reason, /overdue/);
});

test('a decayed card outranks a new one in the queue', () => {
  const brandNew: RevisionCard = {
    id: 'new',
    topicId: 't1',
    subjectId: 'maths',
    state: { stability: 0, difficulty: 5, dueAt: NOW - 1000, reps: 0, lapses: 0 },
  };
  const decayed = card('decayed', 'maths', {
    stability: 1,
    lastReviewedAt: NOW - 40 * DAY_MS,
    dueAt: NOW - 30 * DAY_MS,
  });
  const q = buildQueue([brandNew, decayed], { now: NOW, limit: 5 });
  assert.equal(q.cards[0].id, 'decayed', 'actively decaying material comes first');
});

test('a new card still outranks a comfortably-retained one', () => {
  const brandNew: RevisionCard = {
    id: 'new',
    topicId: 't1',
    subjectId: 'maths',
    state: { stability: 0, difficulty: 5, dueAt: NOW - 1000, reps: 0, lapses: 0 },
  };
  const solid = card('solid', 'maths', { stability: 400, lastReviewedAt: NOW - DAY_MS });
  const q = buildQueue([brandNew, solid], { now: NOW, limit: 5 });
  assert.equal(q.cards[0].id, 'new');
});

test('radar reports a never-reviewed topic as having no retention data', () => {
  const rows = forgetfulnessRadar(
    [
      {
        id: 'n1',
        topicId: 'untouched',
        subjectId: 'maths',
        state: { stability: 0, difficulty: 5, dueAt: NOW, reps: 0, lapses: 0 },
      },
    ],
    NOW,
  );
  assert.equal(rows[0].predictedRetention, undefined);
  assert.equal(rows[0].newCardCount, 1);
  assert.match(rows[0].reason, /not yet reviewed/);
});

test('radar averages retention over reviewed cards only', () => {
  const rows = forgetfulnessRadar(
    [
      { ...card('reviewed', 'maths', { stability: 100, lastReviewedAt: NOW - DAY_MS }), topicId: 'mixed' },
      {
        id: 'fresh',
        topicId: 'mixed',
        subjectId: 'maths',
        state: { stability: 0, difficulty: 5, dueAt: NOW, reps: 0, lapses: 0 },
      },
    ],
    NOW,
  );
  const row = rows.find((r) => r.topicId === 'mixed')!;
  assert.equal(row.cardCount, 2);
  assert.equal(row.newCardCount, 1);
  assert.ok(row.predictedRetention! > 0.95, 'the new card must not drag the average to zero');
  assert.match(row.reason, /1 reviewed card/);
  assert.match(row.reason, /1 not yet reviewed/);
});
