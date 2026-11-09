/**
 * Does the scheduler's forgetting model actually describe *this* learner?
 *
 * Every other number in the product leans on FSRS being roughly right about
 * the user. The weights shipped are the published defaults, fitted to a large
 * population — so the honest thing is to check them against the user's own
 * review log, say how far off they are, and correct them only as far as the
 * evidence supports.
 *
 * Two separate jobs live here, and the distinction matters:
 *
 *   `calibrate` MEASURES. It replays the review log under a given set of
 *   weights and compares what the model predicted with what happened. This
 *   works at any sample size; it just gets noisier.
 *
 *   `fitStabilityScale` FITS. It searches for a correction, and refuses when
 *   the log is too thin to support one. One parameter is fitted, not
 *   seventeen: a few hundred reviews cannot identify seventeen weights, and
 *   pretending otherwise would produce a confident number built on noise.
 */

import type { ReviewGrade, RevisionState } from '../types.ts';
import {
  applyReview,
  retrievability,
  DEFAULT_PARAMS,
  DAY_MS,
  type FsrsParams,
} from './fsrs.ts';

/** One row of the review log, in the order it happened. */
export interface ReviewRecord {
  cardId: string;
  reviewedAt: number;
  grade: ReviewGrade;
}

/** A prediction the model made, paired with what actually happened. */
export interface ScoredReview {
  cardId: string;
  reviewedAt: number;
  /** Modelled probability of recall at the moment of the review. */
  predicted: number;
  /** Grade 1 is a lapse; anything above it means the card was recalled. */
  recalled: boolean;
  elapsedDays: number;
}

/**
 * Reviews that cannot be scored, and why. Reported rather than silently
 * dropped, because the count a metric is computed over is part of the
 * metric's meaning.
 */
export interface ExcludedReviews {
  /** A card's first review: there was no prior state to predict from. */
  firstReview: number;
  /** Same-day repeats: FSRS-4.5 models the long-term trace only. */
  sameDay: number;
}

export interface CalibrationBucket {
  /** Half-open [from, to), except the last bucket which includes 1. */
  from: number;
  to: number;
  count: number;
  /** Mean modelled probability of recall in this bucket. */
  predicted: number;
  /** Fraction actually recalled. */
  observed: number;
}

export type CalibrationVerdict =
  | 'overconfident'
  | 'underconfident'
  | 'indistinguishable'
  | 'insufficient';

export interface Calibration {
  /** Reviews the metrics are computed over. */
  scored: number;
  excluded: ExcludedReviews;
  /** Mean negative log likelihood. Lower is better; 0.325 is chance at p=0.9. */
  logLoss: number;
  /** Mean squared error of the probability. Lower is better. */
  brier: number;
  meanPredicted: number;
  meanObserved: number;
  /** Standard error of `meanObserved`, for judging the gap between the two. */
  standardError: number;
  lapses: number;
  buckets: CalibrationBucket[];
  verdict: CalibrationVerdict;
}

const BUCKET_EDGES = [0, 0.5, 0.7, 0.8, 0.9, 0.95, 1];

/** Probabilities are clamped off 0 and 1 so a single surprise is not infinite loss. */
const EPSILON = 1e-6;

/**
 * Below this, `calibrate` reports `insufficient` rather than a verdict. The
 * metrics are still returned — a small sample is worth showing, it just is
 * not worth concluding from.
 */
export const MIN_REVIEWS_TO_JUDGE = 30;

/**
 * Thresholds for fitting. Reasoned defaults, not empirically derived: one
 * free parameter against a binary outcome needs both a reasonable total and
 * enough of the rarer outcome, since the lapses carry most of the information
 * about how fast memory actually decays.
 */
export const MIN_REVIEWS_TO_FIT = 100;
export const MIN_LAPSES_TO_FIT = 20;

/**
 * Replay the log and collect every scoreable prediction.
 *
 * The replay re-derives each card's state from its first review rather than
 * trusting the stability stored at the time, which is what makes it possible
 * to ask "what would the model have predicted under *different* weights?".
 */
export function replay(
  reviews: readonly ReviewRecord[],
  params: FsrsParams = DEFAULT_PARAMS,
): { scored: ScoredReview[]; excluded: ExcludedReviews } {
  const ordered = [...reviews].sort(
    (a, b) => a.reviewedAt - b.reviewedAt || a.cardId.localeCompare(b.cardId),
  );

  const states = new Map<string, RevisionState>();
  const scored: ScoredReview[] = [];
  const excluded: ExcludedReviews = { firstReview: 0, sameDay: 0 };

  for (const review of ordered) {
    const prior = states.get(review.cardId);
    if (!prior) {
      excluded.firstReview += 1;
    } else {
      const elapsedDays = prior.lastReviewedAt
        ? Math.max(0, (review.reviewedAt - prior.lastReviewedAt) / DAY_MS)
        : 0;
      if (elapsedDays < 1) {
        // A card answered again the same day tests short-term memory, which
        // this model does not claim to describe. Scoring those would flatter
        // the model with near-certain predictions it never really made.
        excluded.sameDay += 1;
      } else {
        scored.push({
          cardId: review.cardId,
          reviewedAt: review.reviewedAt,
          predicted: retrievability(elapsedDays, prior.stability * params.stabilityScale),
          recalled: review.grade > 1,
          elapsedDays,
        });
      }
    }
    // State advances under the params that actually produced the log. The
    // scale is a correction to how that state is *read*, so replaying the
    // history under a candidate scale must not rewrite the history itself.
    states.set(
      review.cardId,
      applyReview(prior, review.grade, review.reviewedAt, DEFAULT_PARAMS).state,
    );
  }

  return { scored, excluded };
}

export function calibrate(
  reviews: readonly ReviewRecord[],
  params: FsrsParams = DEFAULT_PARAMS,
): Calibration {
  const { scored, excluded } = replay(reviews, params);
  const n = scored.length;

  if (n === 0) {
    return {
      scored: 0,
      excluded,
      logLoss: 0,
      brier: 0,
      meanPredicted: 0,
      meanObserved: 0,
      standardError: 0,
      lapses: 0,
      buckets: [],
      verdict: 'insufficient',
    };
  }

  let logLoss = 0;
  let brier = 0;
  let predictedSum = 0;
  let recalledCount = 0;

  for (const s of scored) {
    const p = clampProbability(s.predicted);
    const y = s.recalled ? 1 : 0;
    logLoss -= y * Math.log(p) + (1 - y) * Math.log(1 - p);
    brier += (p - y) ** 2;
    predictedSum += s.predicted;
    recalledCount += y;
  }

  const meanObserved = recalledCount / n;
  const meanPredicted = predictedSum / n;
  const standardError = Math.sqrt((meanObserved * (1 - meanObserved)) / n);

  return {
    scored: n,
    excluded,
    logLoss: logLoss / n,
    brier: brier / n,
    meanPredicted,
    meanObserved,
    standardError,
    lapses: n - recalledCount,
    buckets: bucketise(scored),
    verdict: judge(n, meanPredicted, meanObserved, standardError),
  };
}

/**
 * A verdict is only given when the gap between predicted and observed recall
 * is larger than the sampling noise in the observed rate. Two standard errors
 * is the usual bar, and below `MIN_REVIEWS_TO_JUDGE` no verdict is given at
 * all — with a handful of reviews almost any gap is consistent with chance.
 */
function judge(
  n: number,
  meanPredicted: number,
  meanObserved: number,
  standardError: number,
): CalibrationVerdict {
  if (n < MIN_REVIEWS_TO_JUDGE) return 'insufficient';
  const gap = meanPredicted - meanObserved;
  if (Math.abs(gap) <= 2 * standardError) return 'indistinguishable';
  return gap > 0 ? 'overconfident' : 'underconfident';
}

function bucketise(scored: readonly ScoredReview[]): CalibrationBucket[] {
  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < BUCKET_EDGES.length - 1; i += 1) {
    const from = BUCKET_EDGES[i];
    const to = BUCKET_EDGES[i + 1];
    const last = i === BUCKET_EDGES.length - 2;
    const inBucket = scored.filter(
      (s) => s.predicted >= from && (last ? s.predicted <= to : s.predicted < to),
    );
    if (inBucket.length === 0) continue;
    buckets.push({
      from,
      to,
      count: inBucket.length,
      predicted: inBucket.reduce((sum, s) => sum + s.predicted, 0) / inBucket.length,
      observed: inBucket.filter((s) => s.recalled).length / inBucket.length,
    });
  }
  return buckets;
}

function clampProbability(p: number): number {
  return Math.min(Math.max(p, EPSILON), 1 - EPSILON);
}

// ---------- fitting ----------

export interface FitResult {
  /** True only when the log supported a fit AND the fit beat the defaults. */
  fitted: boolean;
  /** Why not, when `fitted` is false. Written for the user, not the log. */
  reason?: string;
  /**
   * Fitted durability multiplier. 1 is the published model; below 1 means
   * this learner forgets faster than it assumes.
   */
  scale: number;
  /** 95% profile-likelihood interval for `scale`, when one could be computed. */
  interval?: [number, number];
  /**
   * True when the interval contains 1 — the log cannot tell this learner
   * apart from the population the published weights were fitted to.
   */
  includesDefault: boolean;
  logLossBefore: number;
  logLossAfter: number;
  scored: number;
  lapses: number;
}

const SEARCH_MIN = 0.3;
const SEARCH_MAX = 3;
const SEARCH_STEPS = 80;
/** Half of the 95% chi-squared cutoff for one parameter: 3.841 / 2. */
const LIKELIHOOD_DROP = 1.9207;

function logLossAt(
  reviews: readonly ReviewRecord[],
  params: FsrsParams,
  scale: number,
): { loss: number; n: number } {
  const { scored } = replay(reviews, { ...params, stabilityScale: scale });
  if (scored.length === 0) return { loss: 0, n: 0 };
  let total = 0;
  for (const s of scored) {
    const p = clampProbability(s.predicted);
    total -= s.recalled ? Math.log(p) : Math.log(1 - p);
  }
  return { loss: total / scored.length, n: scored.length };
}

/**
 * Search for the durability multiplier that best explains the log.
 *
 * Deterministic by construction: a fixed log-spaced grid followed by a fixed
 * number of ternary-search refinements. The same log always yields the same
 * fit, which is what makes the result something to show a user rather than a
 * number that drifts between page loads.
 *
 * Expect the estimate to sit between 1 and the truth rather than on it. The
 * gaps in the log were chosen by the uncorrected scheduler, which concentrates
 * reviews where it already predicts ~90% recall and leaves little leverage
 * elsewhere. The interval reports that honestly; the point estimate should be
 * read as a direction and a rough size, not a measurement.
 */
export function fitStabilityScale(
  reviews: readonly ReviewRecord[],
  params: FsrsParams = DEFAULT_PARAMS,
): FitResult {
  const baseline = calibrate(reviews, { ...params, stabilityScale: 1 });
  const refuse = (reason: string): FitResult => ({
    fitted: false,
    reason,
    scale: 1,
    includesDefault: true,
    logLossBefore: baseline.logLoss,
    logLossAfter: baseline.logLoss,
    scored: baseline.scored,
    lapses: baseline.lapses,
  });

  if (baseline.scored < MIN_REVIEWS_TO_FIT) {
    return refuse(
      `${baseline.scored} of the ${MIN_REVIEWS_TO_FIT} reviews needed to fit a correction. Keep reviewing — this answers itself.`,
    );
  }
  if (baseline.lapses < MIN_LAPSES_TO_FIT) {
    return refuse(
      `only ${baseline.lapses} lapses in ${baseline.scored} reviews, where ${MIN_LAPSES_TO_FIT} are needed. How fast memory decays is learned mostly from the cards you forget.`,
    );
  }

  // Coarse log-spaced sweep, so the grid is even in multiplicative terms.
  const grid: Array<{ scale: number; loss: number }> = [];
  for (let i = 0; i <= SEARCH_STEPS; i += 1) {
    const scale = Math.exp(
      Math.log(SEARCH_MIN) + ((Math.log(SEARCH_MAX) - Math.log(SEARCH_MIN)) * i) / SEARCH_STEPS,
    );
    grid.push({ scale, loss: logLossAt(reviews, params, scale).loss });
  }

  let bestIndex = 0;
  for (let i = 1; i < grid.length; i += 1) {
    if (grid[i].loss < grid[bestIndex].loss) bestIndex = i;
  }

  // Refine inside the bracketing interval.
  let lo = grid[Math.max(0, bestIndex - 1)].scale;
  let hi = grid[Math.min(grid.length - 1, bestIndex + 1)].scale;
  for (let i = 0; i < 40; i += 1) {
    const a = lo + (hi - lo) / 3;
    const b = hi - (hi - lo) / 3;
    if (logLossAt(reviews, params, a).loss < logLossAt(reviews, params, b).loss) hi = b;
    else lo = a;
  }
  const scale = (lo + hi) / 2;
  const best = logLossAt(reviews, params, scale);

  const interval = profileInterval(grid, scale, best.loss, best.n);
  const includesDefault = interval ? interval[0] <= 1 && interval[1] >= 1 : true;

  if (includesDefault) {
    return {
      ...refuse(
        'the published model already describes your reviews as well as any correction this log can justify.',
      ),
      scale,
      interval,
    };
  }

  return {
    fitted: true,
    scale,
    interval,
    includesDefault,
    logLossBefore: baseline.logLoss,
    logLossAfter: best.loss,
    scored: baseline.scored,
    lapses: baseline.lapses,
  };
}

/**
 * The range of scales the log cannot rule out, from the likelihood ratio.
 * Returns undefined when the curve never rises far enough inside the search
 * range to bound the parameter — reporting no interval is the honest result
 * there, rather than quoting the search bounds as if they were evidence.
 */
function profileInterval(
  grid: ReadonlyArray<{ scale: number; loss: number }>,
  bestScale: number,
  bestLoss: number,
  n: number,
): [number, number] | undefined {
  if (n === 0) return undefined;
  const threshold = bestLoss + LIKELIHOOD_DROP / n;

  const cross = (direction: -1 | 1): number | undefined => {
    const points = direction === -1 ? [...grid].reverse() : grid;
    let previous: { scale: number; loss: number } | undefined;
    for (const point of points) {
      if (direction === 1 ? point.scale <= bestScale : point.scale >= bestScale) {
        previous = point;
        continue;
      }
      if (point.loss >= threshold && previous) {
        const span = point.loss - previous.loss;
        const t = span === 0 ? 0 : (threshold - previous.loss) / span;
        return previous.scale + t * (point.scale - previous.scale);
      }
      previous = point;
    }
    return undefined;
  };

  const lower = cross(-1);
  const upper = cross(1);
  if (lower === undefined || upper === undefined) return undefined;
  return [lower, upper];
}
