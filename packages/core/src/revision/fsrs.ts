/**
 * FSRS-4.5 (Free Spaced Repetition Scheduler).
 *
 * Implemented from the published algorithm rather than fixed intervals,
 * because the product promises real retention modelling. The 17 default
 * weights are the published FSRS-4.5 defaults; they are overridable per user
 * so a future optimiser can fit them to that user's own review log.
 *
 * Reference: open-spaced-repetition/fsrs4anki, "The Algorithm" wiki.
 */

import type { ReviewGrade, RevisionState } from '../types.ts';

export const DECAY = -0.5;
/** Chosen so that R(t = S) == 0.9 exactly. */
export const FACTOR = 19 / 81;

export const DEFAULT_WEIGHTS: readonly number[] = [
  0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072,
  0.0793, 0.3246, 1.587, 0.2272, 2.8755,
];

export const MIN_STABILITY = 0.01;
export const MAX_STABILITY = 36500; // 100 years
export const DAY_MS = 86_400_000;

export interface FsrsParams {
  weights: readonly number[];
  /** Target probability of recall at review time. 0.9 is the usual default. */
  desiredRetention: number;
  /** Hard ceiling on scheduled gaps, in days. */
  maximumInterval: number;
}

export const DEFAULT_PARAMS: FsrsParams = {
  weights: DEFAULT_WEIGHTS,
  desiredRetention: 0.9,
  maximumInterval: 36500,
};

/**
 * Probability of recall after `elapsedDays` with memory stability `stability`.
 * Monotonically decreasing in time; equals `desiredRetention` baseline 0.9 at
 * exactly t == S.
 */
export function retrievability(elapsedDays: number, stability: number): number {
  if (stability <= 0) return 0;
  const t = Math.max(0, elapsedDays);
  return Math.pow(1 + (FACTOR * t) / stability, DECAY);
}

/** Days until recall probability decays to `retention`. Inverse of the above. */
export function intervalForRetention(stability: number, retention: number): number {
  const r = Math.min(Math.max(retention, 0.0001), 0.9999);
  return (stability / FACTOR) * (Math.pow(r, 1 / DECAY) - 1);
}

function clampDifficulty(d: number): number {
  return Math.min(Math.max(d, 1), 10);
}

function clampStability(s: number): number {
  return Math.min(Math.max(s, MIN_STABILITY), MAX_STABILITY);
}

export function initialStability(grade: ReviewGrade, p: FsrsParams = DEFAULT_PARAMS): number {
  return clampStability(p.weights[grade - 1]);
}

export function initialDifficulty(grade: ReviewGrade, p: FsrsParams = DEFAULT_PARAMS): number {
  const w = p.weights;
  return clampDifficulty(w[4] - Math.exp(w[5] * (grade - 1)) + 1);
}

function nextDifficulty(
  difficulty: number,
  grade: ReviewGrade,
  p: FsrsParams,
): number {
  const w = p.weights;
  const delta = -w[6] * (grade - 3);
  const linear = difficulty + (delta * (10 - difficulty)) / 9;
  // Mean reversion toward the difficulty of an "Easy" first answer, which
  // stops difficulty ratcheting upward forever after a run of lapses.
  const reverted = w[7] * initialDifficulty(4, p) + (1 - w[7]) * linear;
  return clampDifficulty(reverted);
}

function stabilityAfterRecall(
  stability: number,
  difficulty: number,
  r: number,
  grade: ReviewGrade,
  p: FsrsParams,
): number {
  const w = p.weights;
  const hardPenalty = grade === 2 ? w[15] : 1;
  const easyBonus = grade === 4 ? w[16] : 1;
  const growth =
    1 +
    Math.exp(w[8]) *
      (11 - difficulty) *
      Math.pow(stability, -w[9]) *
      (Math.exp(w[10] * (1 - r)) - 1) *
      hardPenalty *
      easyBonus;
  return clampStability(stability * growth);
}

function stabilityAfterLapse(
  stability: number,
  difficulty: number,
  r: number,
  p: FsrsParams,
): number {
  const w = p.weights;
  const next =
    w[11] *
    Math.pow(difficulty, -w[12]) *
    (Math.pow(stability + 1, w[13]) - 1) *
    Math.exp(w[14] * (1 - r));
  // A lapse must never increase stability.
  return clampStability(Math.min(next, stability));
}

export interface ReviewOutcome {
  state: RevisionState;
  /** Scheduled gap in days, after rounding and clamping. */
  intervalDays: number;
  /** Recall probability at the moment of this review. */
  retrievabilityAtReview: number;
}

/**
 * Apply one review to a card.
 *
 * `prior` is undefined for a card's first ever review. Same-day reviews
 * (elapsedDays === 0) are deliberately not treated as a full review of the
 * long-term trace: FSRS-4.5 has no short-term component, so stability is held
 * and only difficulty moves. This is documented rather than faked.
 */
export function applyReview(
  prior: RevisionState | undefined,
  grade: ReviewGrade,
  reviewedAt: number,
  params: FsrsParams = DEFAULT_PARAMS,
): ReviewOutcome {
  if (!prior || prior.reps === 0) {
    const stability = initialStability(grade, params);
    const difficulty = initialDifficulty(grade, params);
    return schedule(
      {
        stability,
        difficulty,
        lastReviewedAt: reviewedAt,
        dueAt: reviewedAt,
        reps: 1,
        lapses: grade === 1 ? 1 : 0,
      },
      reviewedAt,
      params,
      1,
    );
  }

  const elapsedDays = prior.lastReviewedAt
    ? Math.max(0, (reviewedAt - prior.lastReviewedAt) / DAY_MS)
    : 0;
  const r = retrievability(elapsedDays, prior.stability);
  const difficulty = nextDifficulty(prior.difficulty, grade, params);

  let stability: number;
  if (elapsedDays < 1) {
    // Same-day repeat: keep the long-term trace, let difficulty absorb it.
    stability = prior.stability;
  } else if (grade === 1) {
    stability = stabilityAfterLapse(prior.stability, difficulty, r, params);
  } else {
    stability = stabilityAfterRecall(prior.stability, difficulty, r, grade, params);
  }

  return schedule(
    {
      stability,
      difficulty,
      lastReviewedAt: reviewedAt,
      dueAt: reviewedAt,
      reps: prior.reps + 1,
      lapses: prior.lapses + (grade === 1 ? 1 : 0),
    },
    reviewedAt,
    params,
    r,
  );
}

function schedule(
  state: RevisionState,
  reviewedAt: number,
  params: FsrsParams,
  rAtReview: number,
): ReviewOutcome {
  const raw = intervalForRetention(state.stability, params.desiredRetention);
  const intervalDays = Math.min(Math.max(Math.round(raw), 1), params.maximumInterval);
  return {
    state: { ...state, dueAt: reviewedAt + intervalDays * DAY_MS },
    intervalDays,
    retrievabilityAtReview: rAtReview,
  };
}

/**
 * What each button would schedule, for the "preview intervals" UI. Pure, so
 * the user sees the real consequence of each grade before pressing it.
 */
export function previewIntervals(
  prior: RevisionState | undefined,
  reviewedAt: number,
  params: FsrsParams = DEFAULT_PARAMS,
): Record<ReviewGrade, number> {
  const grades: ReviewGrade[] = [1, 2, 3, 4];
  const out = {} as Record<ReviewGrade, number>;
  for (const g of grades) out[g] = applyReview(prior, g, reviewedAt, params).intervalDays;
  return out;
}
