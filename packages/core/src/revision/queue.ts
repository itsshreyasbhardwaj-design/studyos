/**
 * Due queue construction, backlog triage and interleaving.
 *
 * The hard problem here is the returning user: 400 cards come due while
 * someone is on holiday. Dumping 400 cards is how people quit, so the queue
 * is capped and triaged — most-at-risk and exam-relevant first — and the
 * remainder is reported as a backlog with an honest drain estimate.
 */

import type { RevisionState } from '../types.ts';
import { DAY_MS, predictedRecall, type FsrsParams } from './fsrs.ts';

export interface RevisionCard {
  id: string;
  topicId: string;
  subjectId: string;
  state: RevisionState;
  /** Flagged because a practice mistake was logged against this topic. */
  flaggedByMistake?: boolean;
}

export interface QueueOptions {
  /** The learner's fitted FSRS params, so shown recall matches scheduled recall. */
  params?: FsrsParams;
  now: number;
  /** Cards to serve in this session. */
  limit: number;
  /** Exam dates by subject, used to prioritise what is assessed soonest. */
  examDates?: Record<string, number>;
  /** Avoid runs of the same subject longer than this. 0 disables interleaving. */
  maxRunPerSubject?: number;
}

export interface QueuedCard extends RevisionCard {
  overdueDays: number;
  /**
   * Undefined for a card that has never been reviewed. A new card has no
   * memory trace to model, so reporting 0% recall would be a fabrication —
   * "never studied" and "completely forgotten" are different claims.
   */
  predictedRetention?: number;
  isNew: boolean;
  priority: number;
  reason: string;
}

export interface RevisionQueue {
  cards: QueuedCard[];
  /** Cards due but not served this session. */
  backlogCount: number;
  /** Sessions of `limit` cards needed to clear the backlog at this rate. */
  backlogSessions: number;
}

export function buildQueue(
  cards: readonly RevisionCard[],
  opts: QueueOptions,
): RevisionQueue {
  const { now, limit, examDates = {}, maxRunPerSubject = 3 } = opts;

  const due = cards
    .filter((c) => c.state.dueAt <= now)
    .map<QueuedCard>((c) => {
      const overdueDays = (now - c.state.dueAt) / DAY_MS;
      const isNew = c.state.reps === 0 || c.state.lastReviewedAt === undefined;
      const predictedRetention = isNew
        ? undefined
        : predictedRecall(c.state, now, opts.params)!;
      const examAt = examDates[c.subjectId];
      const daysToExam = examAt ? (examAt - now) / DAY_MS : undefined;

      const reasons: string[] = [];
      // New cards get a fixed middling priority: they should be learned, but
      // not ahead of material that is actively decaying.
      let priority = isNew ? 30 : (1 - predictedRetention!) * 100;
      if (isNew) {
        reasons.push('new card, never reviewed');
      } else if (predictedRetention! < 0.9) {
        reasons.push(`modelled recall ${(predictedRetention! * 100).toFixed(0)}%`);
      }
      if (!isNew && overdueDays > 0) {
        priority += Math.min(overdueDays, 30);
        reasons.push(`${overdueDays.toFixed(0)}d overdue`);
      }
      if (daysToExam !== undefined && daysToExam >= 0 && daysToExam <= 30) {
        priority += (30 - daysToExam) * 2;
        reasons.push(`exam in ${Math.ceil(daysToExam)}d`);
      }
      if (c.flaggedByMistake) {
        priority += 25;
        reasons.push('recent mistake logged');
      }
      if (c.state.lapses > 2) {
        priority += c.state.lapses * 2;
        reasons.push(`${c.state.lapses} lapses`);
      }

      return {
        ...c,
        overdueDays,
        predictedRetention,
        isNew,
        priority,
        reason: reasons.join(' · ') || 'scheduled review',
      };
    })
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

  const selected = interleave(due.slice(0, limit), maxRunPerSubject);

  return {
    cards: selected,
    backlogCount: Math.max(0, due.length - limit),
    backlogSessions: limit > 0 ? Math.ceil(due.length / limit) : 0,
  };
}

/**
 * Reorder so no subject runs longer than `maxRun`. Interleaved practice
 * measurably beats blocked practice for retention, so this is a default
 * rather than an option buried in settings.
 */
export function interleave<T extends { subjectId: string }>(cards: T[], maxRun: number): T[] {
  if (maxRun <= 0 || cards.length <= maxRun) return cards;

  const buckets = new Map<string, T[]>();
  for (const c of cards) {
    const bucket = buckets.get(c.subjectId);
    if (bucket) bucket.push(c);
    else buckets.set(c.subjectId, [c]);
  }

  const out: T[] = [];
  let run = 0;
  let lastSubject: string | undefined;

  while (out.length < cards.length) {
    // Prefer the fullest bucket, but never extend a run past the cap.
    const candidates = [...buckets.entries()]
      .filter(([, list]) => list.length > 0)
      .sort((a, b) => b[1].length - a[1].length);
    if (candidates.length === 0) break;

    let pick = candidates.find(
      ([subject]) => !(subject === lastSubject && run >= maxRun),
    );
    pick ??= candidates[0];

    const [subject, list] = pick;
    out.push(list.shift()!);
    run = subject === lastSubject ? run + 1 : 1;
    lastSubject = subject;
  }
  return out;
}
