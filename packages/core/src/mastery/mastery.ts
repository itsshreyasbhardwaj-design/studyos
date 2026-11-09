/**
 * Mastery from evidence, never from hours.
 *
 * The product's central claim is that it refuses to confuse time spent with
 * learning achieved. That promise lives or dies here: this module is given no
 * access to study duration at all. It can only see graded performance and
 * retention. Adding an hours input to this function would be a product
 * regression, not a feature.
 */

import type { MasteryState, PracticeAttempt } from '../types.ts';
import { DAY_MS, predictedRecall, type FsrsParams } from '../revision/fsrs.ts';
import type { RevisionState } from '../types.ts';

export interface MasteryEvidence {
  attempts: readonly PracticeAttempt[];
  /** Revision states for this topic's cards, if any exist. */
  revisionStates?: readonly RevisionState[];
  /** Unresolved mistake-notebook entries for this topic. */
  openMistakes?: number;
  now: number;
  /**
   * The learner's fitted FSRS params. Retention evidence must be read through
   * the same correction the scheduler uses; note this carries no duration,
   * and must not — see the assertion in mastery.test.ts.
   */
  params?: FsrsParams;
}

export interface MasteryAssessment {
  state: MasteryState;
  /** Accuracy over graded attempts, or undefined when there are none. */
  accuracy?: number;
  attemptCount: number;
  /** Distinct calendar days on which attempts were made. */
  distinctDays: number;
  /** Mean modelled recall across the topic's cards, if tracked. */
  predictedRetention?: number;
  /** Why this state, in the order the rules fired. */
  reasons: string[];
  /** What would move this topic up a level. */
  nextStep: string;
}

const STRONG_ACCURACY = 0.8;
const MASTERED_ACCURACY = 0.9;
const PRACTISING_MIN_ATTEMPTS = 3;
const STRONG_MIN_ATTEMPTS = 6;
const MASTERED_MIN_ATTEMPTS = 10;
const MASTERED_MIN_DAYS = 2;
const RETENTION_FLOOR = 0.85;
const RECENT_WINDOW_DAYS = 14;

export function assessMastery(evidence: MasteryEvidence): MasteryAssessment {
  const { attempts, revisionStates = [], openMistakes = 0, now, params } = evidence;
  const reasons: string[] = [];

  const graded = attempts.filter((a) => a.correct !== undefined);
  const attemptCount = graded.length;
  const accuracy =
    attemptCount > 0
      ? graded.reduce((sum, a) => sum + (a.score ?? (a.correct ? 1 : 0)), 0) / attemptCount
      : undefined;

  const distinctDays = new Set(
    graded.map((a) => Math.floor(a.attemptedAt / DAY_MS)),
  ).size;

  // Only reviewed cards carry retention information. Counting a brand-new
  // card as 0% recall would push an untouched topic straight to
  // "needs revision", which is the opposite of the truth.
  const reviewedStates = revisionStates.filter(
    (s) => s.reps > 0 && s.lastReviewedAt !== undefined,
  );
  const predictedRetention =
    reviewedStates.length > 0
      ? reviewedStates
          .map((s) => predictedRecall(s, now, params)!)
          .reduce((a, b) => a + b, 0) / reviewedStates.length
      : undefined;

  const recentLapses = reviewedStates.filter(
    (s) =>
      s.lapses > 0 &&
      s.lastReviewedAt !== undefined &&
      now - s.lastReviewedAt < RECENT_WINDOW_DAYS * DAY_MS,
  ).length;

  const base: Omit<MasteryAssessment, 'state' | 'nextStep'> = {
    accuracy,
    attemptCount,
    distinctDays,
    predictedRetention,
    reasons,
  };

  // No evidence at all. Note: study time is intentionally not consulted.
  if (attemptCount === 0 && reviewedStates.length === 0) {
    reasons.push('no graded attempts or reviews recorded');
    return {
      ...base,
      state: 'not_started',
      nextStep: `Answer ${PRACTISING_MIN_ATTEMPTS} practice questions to establish a baseline.`,
    };
  }

  // Decay and fresh errors override any earlier good performance.
  if (predictedRetention !== undefined && predictedRetention < RETENTION_FLOOR) {
    reasons.push(
      `modelled recall ${(predictedRetention * 100).toFixed(0)}% is below the ${(RETENTION_FLOOR * 100).toFixed(0)}% floor`,
    );
    return {
      ...base,
      state: 'needs_revision',
      nextStep: 'Clear the due reviews for this topic, then re-test.',
    };
  }
  if (openMistakes > 0) {
    reasons.push(`${openMistakes} unresolved mistake${openMistakes === 1 ? '' : 's'} logged`);
    return {
      ...base,
      state: 'needs_revision',
      nextStep: 'Work through the mistake notebook entries and retry those questions.',
    };
  }
  if (recentLapses > 0) {
    reasons.push(`${recentLapses} card${recentLapses === 1 ? '' : 's'} lapsed in the last ${RECENT_WINDOW_DAYS} days`);
    return {
      ...base,
      state: 'needs_revision',
      nextStep: 'Review the lapsed cards before moving on.',
    };
  }

  if (attemptCount < PRACTISING_MIN_ATTEMPTS) {
    reasons.push(`only ${attemptCount} graded attempt${attemptCount === 1 ? '' : 's'} so far`);
    return {
      ...base,
      state: 'learning',
      nextStep: `Reach ${PRACTISING_MIN_ATTEMPTS} graded attempts to show a pattern.`,
    };
  }

  const acc = accuracy ?? 0;
  reasons.push(
    `${(acc * 100).toFixed(0)}% accuracy over ${attemptCount} attempts on ${distinctDays} day${distinctDays === 1 ? '' : 's'}`,
  );
  if (predictedRetention !== undefined) {
    reasons.push(`modelled recall ${(predictedRetention * 100).toFixed(0)}%`);
  }

  if (
    acc >= MASTERED_ACCURACY &&
    attemptCount >= MASTERED_MIN_ATTEMPTS &&
    distinctDays >= MASTERED_MIN_DAYS &&
    (predictedRetention === undefined || predictedRetention >= 0.9)
  ) {
    return {
      ...base,
      state: 'mastered',
      nextStep: 'Maintain with scheduled reviews; no new practice needed.',
    };
  }

  if (acc >= STRONG_ACCURACY && attemptCount >= STRONG_MIN_ATTEMPTS) {
    const gaps: string[] = [];
    if (acc < MASTERED_ACCURACY) gaps.push(`accuracy to ${MASTERED_ACCURACY * 100}%`);
    if (attemptCount < MASTERED_MIN_ATTEMPTS) {
      gaps.push(`${MASTERED_MIN_ATTEMPTS - attemptCount} more attempts`);
    }
    if (distinctDays < MASTERED_MIN_DAYS) gaps.push('attempts on a second day');
    return {
      ...base,
      state: 'strong',
      nextStep: `For mastery: ${gaps.join(', ') || 'hold retention with reviews'}.`,
    };
  }

  if (acc < 0.5) {
    reasons.push('accuracy below 50% — the gap is understanding, not recall');
    return {
      ...base,
      state: 'learning',
      nextStep: 'Re-study the explanation, then retry a worked example before more practice.',
    };
  }

  return {
    ...base,
    state: 'practising',
    nextStep: `Reach ${STRONG_ACCURACY * 100}% accuracy over ${STRONG_MIN_ATTEMPTS}+ attempts.`,
  };
}

/** Human-facing label and ordering for the mastery ladder. */
export const MASTERY_ORDER: readonly MasteryState[] = [
  'not_started',
  'learning',
  'practising',
  'needs_revision',
  'strong',
  'mastered',
];

export const MASTERY_LABELS: Record<MasteryState, string> = {
  not_started: 'Not started',
  learning: 'Learning',
  practising: 'Practising',
  needs_revision: 'Needs revision',
  strong: 'Strong',
  mastered: 'Mastered by demonstrated performance',
};
