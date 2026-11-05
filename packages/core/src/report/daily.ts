/**
 * Daily Intelligence Report.
 *
 * Assembled entirely from stored records. Where a figure is modelled rather
 * than measured it is wrapped in Provenanced<T> and rendered with its label,
 * so the report can never read as if the system observed something it didn't.
 */

import type { Provenanced } from '../types.ts';
import type { PeriodMetrics } from '../analytics/metrics.ts';
import { planAdherence } from '../analytics/metrics.ts';
import type { RadarRow } from '../revision/radar.ts';
import type { Plan } from '../planning/scheduler.ts';

export interface DailyReport {
  date: string;
  headline: string;
  metrics: {
    recordedMinutes: Provenanced<number>;
    activeMinutes: Provenanced<number>;
    breakMinutes: number;
    distractionMinutes: number;
    bySubjectMinutes: Array<{ subjectId: string; minutes: number }>;
    byDeviceMinutes: Array<{ deviceId: string; minutes: number }>;
    tasksCompleted: number;
    tasksOutstanding: number;
    plannedVsActual: ReturnType<typeof planAdherence>;
    questionsAttempted: number;
    practiceAccuracy?: Provenanced<number>;
    reviewsCompleted: number;
    mistakesLogged: number;
  };
  /** Topics the radar flags, each with its stated evidence. */
  reviseNext: Array<{ topicId: string; reason: string; predictedRetention?: number }>;
  /** Deterministic observations. Not LLM prose — these are rule outputs. */
  observations: string[];
  /** Questions for the optional end-of-day reflection. */
  reflectionPrompts: string[];
  /** Warnings about data quality, so the user can correct the record. */
  dataQuality: string[];
}

export interface DailyReportInput {
  at: number;
  metrics: PeriodMetrics;
  radar: readonly RadarRow[];
  tomorrowPlan?: Plan;
  subjectNames?: Record<string, string>;
}

export function buildDailyReport(input: DailyReportInput): DailyReport {
  const { at, metrics, radar, tomorrowPlan } = input;
  const minutes = (ms: number) => Math.round(ms / 60000);
  const adherence = planAdherence(metrics);

  const observations: string[] = [];
  const dataQuality: string[] = [];

  const productive = minutes(metrics.time.productiveMs);
  if (productive === 0) {
    observations.push('No productive time was recorded today. If you studied offline, add a manual session so the record is accurate.');
  } else {
    observations.push(`${formatMinutes(productive)} of productive time recorded across ${Object.keys(metrics.time.bySubject).length || 1} subject area(s).`);
  }

  if (metrics.focusRatio.value > 0 && metrics.focusRatio.value < 0.6) {
    observations.push(
      `Active interaction covered ${(metrics.focusRatio.value * 100).toFixed(0)}% of recorded time — the rest was idle or away. Shorter, closer-spaced sessions may record more accurately.`,
    );
  }

  if (adherence.plannedMinutes > 0) {
    if (adherence.deltaMinutes < -30) {
      observations.push(
        `${formatMinutes(Math.abs(adherence.deltaMinutes))} less than planned. Tomorrow's plan carries the remainder rather than discarding it.`,
      );
    } else if (adherence.deltaMinutes > 30) {
      observations.push(`${formatMinutes(adherence.deltaMinutes)} more than planned.`);
    } else {
      observations.push('Recorded time matched the plan within half an hour.');
    }
  }

  if (metrics.practiceAccuracy) {
    observations.push(
      `${(metrics.practiceAccuracy.value * 100).toFixed(0)}% accuracy over ${metrics.questionsAttempted} graded questions — this is demonstrated performance, not an estimate.`,
    );
  } else if (metrics.questionsAttempted === 0) {
    observations.push('No practice questions were graded today, so there is no new evidence of what you have learned — only of time spent.');
  }

  if (metrics.time.distractionMs > 30 * 60_000) {
    observations.push(`${formatMinutes(minutes(metrics.time.distractionMs))} was categorised as distraction.`);
  }

  if (tomorrowPlan) {
    if (!tomorrowPlan.feasible) {
      const willMiss = tomorrowPlan.risks.filter((r) => r.verdict === 'will_miss').length;
      observations.push(
        `Tomorrow's plan does not fit the time available: ${tomorrowPlan.unscheduled.length} item(s) unscheduled${willMiss ? ` and ${willMiss} deadline(s) at risk` : ''}. Cut scope or add hours.`,
      );
    } else {
      observations.push(`Tomorrow's plan fits in ${formatMinutes(Math.round(tomorrowPlan.supplyMinutes))} of free time.`);
    }
  }

  if (metrics.time.conflictMs > 0) {
    dataQuality.push(
      `${minutes(metrics.time.conflictMs)} min of overlapping reports from multiple devices were attributed to one source by precedence. Review the timeline if the subject split looks wrong.`,
    );
  }
  if (metrics.time.byCategory['unclassified']) {
    dataQuality.push(
      `${minutes(metrics.time.byCategory['unclassified'])} min is unclassified. Categorising it improves tomorrow's plan.`,
    );
  }

  const activeProvenance = metrics.focusRatio.provenance;

  return {
    date: new Date(at).toISOString().slice(0, 10),
    headline:
      productive > 0
        ? `${formatMinutes(productive)} productive · ${metrics.tasksCompleted} task(s) done · ${metrics.reviewsCompleted} review(s)`
        : 'No activity recorded today',
    metrics: {
      recordedMinutes: {
        value: minutes(metrics.time.elapsedMs),
        provenance: 'measured',
        reason: 'union of all recorded activity windows',
      },
      activeMinutes: {
        value: minutes(metrics.time.activeMs),
        provenance: activeProvenance,
        reason: metrics.focusRatio.reason,
      },
      breakMinutes: minutes(metrics.time.breakMs),
      distractionMinutes: minutes(metrics.time.distractionMs),
      bySubjectMinutes: Object.entries(metrics.time.bySubject)
        .map(([subjectId, ms]) => ({ subjectId, minutes: minutes(ms) }))
        .sort((a, b) => b.minutes - a.minutes),
      byDeviceMinutes: Object.entries(metrics.time.byDevice)
        .map(([deviceId, ms]) => ({ deviceId, minutes: minutes(ms) }))
        .sort((a, b) => b.minutes - a.minutes),
      tasksCompleted: metrics.tasksCompleted,
      tasksOutstanding: metrics.tasksOutstanding,
      plannedVsActual: adherence,
      questionsAttempted: metrics.questionsAttempted,
      practiceAccuracy: metrics.practiceAccuracy,
      reviewsCompleted: metrics.reviewsCompleted,
      mistakesLogged: metrics.mistakesLogged,
    },
    reviseNext: radar.slice(0, 5).map((r) => ({
      topicId: r.topicId,
      reason: r.reason,
      predictedRetention: r.predictedRetention,
    })),
    observations,
    reflectionPrompts: [
      'What did you learn today that you could explain to someone else?',
      'What was hardest, and what specifically made it hard?',
      'What should change tomorrow?',
    ],
    dataQuality,
  };
}

export function formatMinutes(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
