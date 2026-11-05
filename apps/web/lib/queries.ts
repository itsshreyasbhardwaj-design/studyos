import 'server-only';
import * as repo from '@studyos/db';
import {
  aggregateEvents,
  assessMastery,
  buildDailyReport,
  buildQueue,
  computePeriodMetrics,
  consistency,
  dailyTrend,
  dayWindow,
  forgetfulnessRadar,
  plan,
  reconstructTimeline,
  weekWindow,
  DAY_MS,
  type Plan,
} from '@studyos/core';
import { db, currentUserId } from './db.ts';

/** Everything the Command Center needs, in one pass over the stored records. */
export function loadDashboard(now = Date.now()) {
  const conn = db();
  const userId = currentUserId();
  const today = dayWindow(now);

  const events = repo.listEvents(conn, userId, today.from, today.to);
  const tasks = repo.listTasks(conn, userId, { includeCompleted: true });
  const attempts = repo.listAttempts(conn, userId);
  const cards = repo.listRevisionCards(conn, userId);
  const exams = repo.listExams(conn, userId);
  const subjects = repo.listSubjects(conn, userId);
  const availability = repo.listAvailability(conn, userId, now, now + 2 * DAY_MS);

  const examDates: Record<string, number> = {};
  for (const e of exams) {
    if (e.startsAt >= now && (!examDates[e.subjectId] || e.startsAt < examDates[e.subjectId])) {
      examDates[e.subjectId] = e.startsAt;
    }
  }

  const queue = buildQueue(cards, { now, limit: 20, examDates });
  const radar = forgetfulnessRadar(cards, now, examDates);
  const metrics = computePeriodMetrics({
    window: today,
    events,
    tasks,
    attempts,
    reviewTimestamps: repo.listReviewTimestamps(conn, userId, today.from, today.to),
  });

  const openTasks = tasks.filter((t) => !t.completedAt);
  const todayPlan = plan({
    now,
    tasks: openTasks,
    availability,
    revisionMinutes: Math.min(queue.cards.length * 2, 45),
    exams,
  });

  return {
    userId,
    now,
    subjects,
    subjectNames: Object.fromEntries(subjects.map((s) => [s.id, s.name])),
    tasks: openTasks,
    metrics,
    queue,
    radar,
    exams: exams.filter((e) => e.startsAt >= now).slice(0, 4),
    plan: todayPlan,
    timeline: reconstructTimeline(events, today.from, today.to),
    dueCount: cards.filter((c) => c.state.dueAt <= now).length,
    cardCount: cards.length,
  };
}

export function loadPlanner(now = Date.now()) {
  const conn = db();
  const userId = currentUserId();
  const tasks = repo.listTasks(conn, userId);
  const exams = repo.listExams(conn, userId);
  const availability = repo.listAvailability(conn, userId, now, now + 8 * DAY_MS);
  const cards = repo.listRevisionCards(conn, userId);
  const dueCount = cards.filter((c) => c.state.dueAt <= now).length;
  const subjects = repo.listSubjects(conn, userId);

  const base = {
    now,
    tasks,
    availability,
    exams,
    revisionMinutes: Math.min(dueCount * 2, 45),
  };

  const scenarios: Array<{ label: string; plan: Plan }> = [
    { label: 'Current plan', plan: plan(base) },
    {
      label: 'If I lose tomorrow',
      plan: plan({
        ...base,
        availability: availability.filter((b) => b.startsAt > now + 2 * DAY_MS),
      }),
    },
    {
      // Appended after the last existing block so the extra hours are genuinely
      // additive rather than overlapping time already marked free.
      label: 'If I add 2h of free time',
      plan: plan({
        ...base,
        availability: [...availability, extraHours(availability, now, 2)],
      }),
    },
  ];

  return {
    subjectNames: Object.fromEntries(subjects.map((s) => [s.id, s.name])),
    taskNames: Object.fromEntries(tasks.map((t) => [t.id, t.title])),
    tasks,
    availability,
    scenarios,
    now,
  };
}

/** A block of `hours` appended after all existing availability. */
function extraHours(
  availability: readonly { startsAt: number; endsAt: number }[],
  now: number,
  hours: number,
): { startsAt: number; endsAt: number; label: string } {
  const lastEnd = availability.reduce((max, b) => Math.max(max, b.endsAt), now);
  return { startsAt: lastEnd, endsAt: lastEnd + hours * 3_600_000, label: 'Extra study time' };
}

export function loadRevision(now = Date.now()) {
  const conn = db();
  const userId = currentUserId();
  const cards = repo.listRevisionCards(conn, userId);
  const exams = repo.listExams(conn, userId);
  const subjects = repo.listSubjects(conn, userId);

  const examDates: Record<string, number> = {};
  for (const e of exams) {
    if (e.startsAt >= now && (!examDates[e.subjectId] || e.startsAt < examDates[e.subjectId])) {
      examDates[e.subjectId] = e.startsAt;
    }
  }

  const queue = buildQueue(cards, { now, limit: 20, examDates });
  const detail = conn
    .prepare(
      `SELECT c.id, c.front, c.back, t.name AS topic_name, s.name AS subject_name
       FROM flashcards c JOIN topics t ON t.id = c.topic_id
       JOIN subjects s ON s.id = t.subject_id WHERE c.user_id = ?`,
    )
    .all(userId) as Array<{ id: string; front: string; back: string; topic_name: string; subject_name: string }>;
  // node:sqlite returns null-prototype rows, which cannot cross the server →
  // client boundary. Everything handed to a client component is rebuilt as a
  // plain object literal carrying only the fields that component needs.
  const byId = new Map(
    detail.map((d) => [
      d.id,
      { front: d.front, back: d.back, topicName: d.topic_name, subjectName: d.subject_name },
    ]),
  );

  return {
    now,
    queue: {
      cards: queue.cards.map((c) => ({
        id: c.id,
        subjectId: c.subjectId,
        topicId: c.topicId,
        predictedRetention: c.predictedRetention,
        isNew: c.isNew,
        reason: c.reason,
        detail: byId.get(c.id),
      })),
      backlogCount: queue.backlogCount,
      backlogSessions: queue.backlogSessions,
    },
    radar: forgetfulnessRadar(cards, now, examDates),
    topicNames: Object.fromEntries(
      (
        conn
          .prepare(
            `SELECT t.id, t.name FROM topics t JOIN subjects s ON s.id = t.subject_id WHERE s.user_id = ?`,
          )
          .all(userId) as Array<{ id: string; name: string }>
      ).map((t) => [t.id, t.name]),
    ),
    subjectNames: Object.fromEntries(subjects.map((s) => [s.id, s.name])),
    totalCards: cards.length,
  };
}

export function loadSubjects(now = Date.now()) {
  const conn = db();
  const userId = currentUserId();
  const subjects = repo.listSubjects(conn, userId);
  const allTopics = repo.listTopics(conn, userId);
  const cards = repo.listRevisionCards(conn, userId);
  const events = repo.listEvents(conn, userId, now - 30 * DAY_MS, now);

  const byTopic = new Map<string, typeof cards>();
  for (const c of cards) {
    const list = byTopic.get(c.topicId);
    if (list) list.push(c);
    else byTopic.set(c.topicId, [c]);
  }

  return {
    subjects: subjects.map((s) => {
      const topics = allTopics.filter((t) => t.subject_id === s.id);
      const assessed = topics.map((t) => {
        const attempts = repo.listAttempts(conn, userId, t.id);
        const assessment = assessMastery({
          attempts,
          revisionStates: (byTopic.get(t.id) ?? []).map((c) => c.state),
          openMistakes: repo.countOpenMistakes(conn, userId, t.id),
          now,
        });
        return { id: t.id, name: t.name, assessment };
      });
      const totals = aggregateEvents(
        events.filter((e) => e.subjectId === s.id),
        now - 30 * DAY_MS,
        now,
      );
      return {
        ...s,
        topics: assessed,
        thirtyDayMinutes: Math.round(totals.productiveMs / 60_000),
      };
    }),
  };
}

export function loadAnalytics(now = Date.now()) {
  const conn = db();
  const userId = currentUserId();
  const from = dayWindow(now - 29 * DAY_MS).from;

  const events = repo.listEvents(conn, userId, from, now + DAY_MS);
  const tasks = repo.listTasks(conn, userId, { includeCompleted: true });
  const attempts = repo.listAttempts(conn, userId);
  const reviewTimestamps = repo.listReviewTimestamps(conn, userId, from, now + DAY_MS);
  const subjects = repo.listSubjects(conn, userId);

  const trend = dailyTrend({ events, tasks, attempts, reviewTimestamps }, from, 30);
  const week = weekWindow(now);

  return {
    now,
    trend,
    consistency: consistency(trend),
    thisWeek: computePeriodMetrics({
      window: week,
      events,
      tasks,
      attempts,
      reviewTimestamps,
    }),
    thirtyDay: computePeriodMetrics({
      window: { from, to: now + DAY_MS },
      events,
      tasks,
      attempts,
      reviewTimestamps,
    }),
    subjectNames: Object.fromEntries(subjects.map((s) => [s.id, s.name])),
  };
}

export function loadReport(now = Date.now()) {
  const conn = db();
  const userId = currentUserId();
  const today = dayWindow(now);

  const events = repo.listEvents(conn, userId, today.from, today.to);
  const tasks = repo.listTasks(conn, userId, { includeCompleted: true });
  const attempts = repo.listAttempts(conn, userId);
  const cards = repo.listRevisionCards(conn, userId);
  const subjects = repo.listSubjects(conn, userId);
  const exams = repo.listExams(conn, userId);

  const todayPlan = plan({
    now: today.to,
    tasks: tasks.filter((t) => !t.completedAt),
    availability: repo.listAvailability(conn, userId, today.to, today.to + DAY_MS),
    exams,
  });

  const metrics = computePeriodMetrics({
    window: today,
    events,
    tasks,
    attempts,
    reviewTimestamps: repo.listReviewTimestamps(conn, userId, today.from, today.to),
    plannedMinutes: 180,
  });

  return {
    report: buildDailyReport({
      at: now,
      metrics,
      radar: forgetfulnessRadar(cards, now),
      tomorrowPlan: todayPlan,
    }),
    subjectNames: Object.fromEntries(subjects.map((s) => [s.id, s.name])),
    topicNames: Object.fromEntries(
      (
        conn
          .prepare(
            `SELECT t.id, t.name FROM topics t JOIN subjects s ON s.id = t.subject_id WHERE s.user_id = ?`,
          )
          .all(userId) as Array<{ id: string; name: string }>
      ).map((t) => [t.id, t.name]),
    ),
  };
}
