/**
 * Forgetfulness Radar: which topics are decaying, why, and how urgent.
 *
 * Every row states the evidence behind it. The radar never claims a topic is
 * forgotten — it reports modelled recall probability and labels it as such.
 */

import { DAY_MS, predictedRecall, type FsrsParams } from './fsrs.ts';
import type { RevisionCard } from './queue.ts';

export interface RadarRow {
  topicId: string;
  subjectId: string;
  cardCount: number;
  /**
   * Mean modelled recall across the topic's *reviewed* cards, in [0,1].
   * Undefined when no card in the topic has been reviewed yet.
   */
  predictedRetention?: number;
  /** Cards in this topic that have never been reviewed. */
  newCardCount: number;
  lastReviewedAt?: number;
  nextDueAt: number;
  totalLapses: number;
  daysToExam?: number;
  /** Higher = review sooner. Unitless, comparable only within one radar run. */
  risk: number;
  reason: string;
}

export function forgetfulnessRadar(
  cards: readonly RevisionCard[],
  now: number,
  examDates: Record<string, number> = {},
  params?: FsrsParams,
): RadarRow[] {
  const byTopic = new Map<string, RevisionCard[]>();
  for (const c of cards) {
    const list = byTopic.get(c.topicId);
    if (list) list.push(c);
    else byTopic.set(c.topicId, [c]);
  }

  const rows: RadarRow[] = [];
  for (const [topicId, group] of byTopic) {
    const reviewed = group.filter(
      (c) => c.state.reps > 0 && c.state.lastReviewedAt !== undefined,
    );
    const retentions = reviewed.map((c) => predictedRecall(c.state, now, params)!);
    const predictedRetention =
      retentions.length > 0
        ? retentions.reduce((a, b) => a + b, 0) / retentions.length
        : undefined;
    const newCardCount = group.length - reviewed.length;
    const lastReviewedAt = group
      .map((c) => c.state.lastReviewedAt)
      .filter((t): t is number => t !== undefined)
      .sort((a, b) => b - a)[0];
    const nextDueAt = Math.min(...group.map((c) => c.state.dueAt));
    const totalLapses = group.reduce((sum, c) => sum + c.state.lapses, 0);
    const examAt = examDates[group[0].subjectId];
    const daysToExam = examAt ? (examAt - now) / DAY_MS : undefined;

    const reasons: string[] = [];
    let risk: number;
    if (predictedRetention === undefined) {
      reasons.push(
        `${newCardCount} card${newCardCount === 1 ? '' : 's'} not yet reviewed — no retention data`,
      );
      risk = 35;
    } else {
      reasons.push(
        `modelled recall ${(predictedRetention * 100).toFixed(0)}% across ${reviewed.length} reviewed card${reviewed.length === 1 ? '' : 's'}`,
      );
      if (newCardCount > 0) reasons.push(`${newCardCount} not yet reviewed`);
      risk = (1 - predictedRetention) * 100;
    }
    if (totalLapses > 0) {
      risk += totalLapses * 3;
      reasons.push(`${totalLapses} lapse${totalLapses === 1 ? '' : 's'} on record`);
    }
    if (daysToExam !== undefined && daysToExam >= 0 && daysToExam <= 45) {
      risk *= 1 + (45 - daysToExam) / 45;
      reasons.push(`assessed in ${Math.ceil(daysToExam)} days`);
    }
    if (nextDueAt <= now) {
      risk += 10;
      reasons.push('already due');
    }

    rows.push({
      topicId,
      subjectId: group[0].subjectId,
      cardCount: group.length,
      newCardCount,
      predictedRetention,
      lastReviewedAt,
      nextDueAt,
      totalLapses,
      daysToExam,
      risk,
      reason: reasons.join(' · '),
    });
  }

  return rows.sort((a, b) => b.risk - a.risk || a.topicId.localeCompare(b.topicId));
}
