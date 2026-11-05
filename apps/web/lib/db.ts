import 'server-only';
import path from 'node:path';
import { openDb, type Db } from '@studyos/db';
import * as repo from '@studyos/db';
import { DAY_MS } from '@studyos/core';

/**
 * One SQLite connection per server process. The file lives in the repo root by
 * default so a fresh clone runs with no configuration, no container and no
 * account — the "works with an empty environment" requirement.
 */
let cached: Db | undefined;

export function db(): Db {
  if (cached) return cached;
  const file = process.env.STUDYOS_DB_PATH ?? path.join(process.cwd(), '..', '..', 'studyos.db');
  cached = openDb({ path: file });
  seedIfEmpty(cached);
  return cached;
}

export const DEMO_USER_ID_KEY = 'studyos.demo.user';

/** The signed-in user. Single-user local mode until auth lands. */
export function currentUserId(): string {
  const conn = db();
  const row = conn.prepare('SELECT id FROM users ORDER BY created_at LIMIT 1').get() as
    | { id: string }
    | undefined;
  if (row) return row.id;
  return repo.createUser(conn, { displayName: 'Student', timezone: 'UTC' }).id;
}

/**
 * Seed a sample student so the first run shows a populated product instead of
 * empty states. Everything seeded is labelled as demo data in the UI; none of
 * it is presented as the viewer's own tracked activity.
 */
function seedIfEmpty(conn: Db): void {
  const existing = conn.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  if (existing.n > 0) return;

  const now = Date.now();
  const user = repo.createUser(conn, { displayName: 'Demo Student', timezone: 'UTC' });

  const plan: Array<[string, string, string[]]> = [
    ['Physics HL', 'IB DP', ['Kinematics', 'Forces and momentum', 'Work and energy', 'Wave behaviour']],
    ['Mathematics AA HL', 'IB DP', ['Differentiation', 'Integration', 'Vectors', 'Complex numbers']],
    ['Computer Science HL', 'IB DP', ['Abstract data structures', 'Recursion', 'Databases']],
    ['Economics SL', 'IB DP', ['Elasticity', 'Market failure', 'Macro objectives']],
  ];

  const topicIds: Record<string, string> = {};
  for (const [name, curriculum, topics] of plan) {
    const subject = repo.createSubject(conn, user.id, { name, curriculum, level: name.endsWith('HL') ? 'HL' : 'SL' });
    topics.forEach((topicName, i) => {
      const { id } = repo.createTopic(conn, { subjectId: subject.id, name: topicName, position: i });
      topicIds[`${name}/${topicName}`] = id;

      // Two cards per topic, with varied review histories so the radar and the
      // queue have something real to rank.
      for (let c = 0; c < 2; c++) {
        const { id: cardId } = repo.createCard(conn, user.id, {
          topicId: id,
          front: `${topicName}: recall prompt ${c + 1}`,
          back: `Worked answer for ${topicName} (${c + 1})`,
        });
        const age = (i * 2 + c) % 5;
        if (age > 0) {
          // Grade it in the past so stability and due dates are genuine FSRS output.
          const firstAt = now - (age * 7 + 3) * DAY_MS;
          repo.gradeCard(conn, user.id, cardId, age % 3 === 0 ? 2 : 3, firstAt);
          if (age > 2) repo.gradeCard(conn, user.id, cardId, age % 2 === 0 ? 1 : 3, firstAt + 4 * DAY_MS);
        }
      }
    });

    if (name === 'Physics HL') {
      repo.createExam(conn, user.id, {
        subjectId: subject.id, title: 'Physics HL Paper 1', component: 'Paper 1',
        startsAt: now + 12 * DAY_MS,
      });
      repo.createExam(conn, user.id, {
        subjectId: subject.id, title: 'Physics HL Paper 2', component: 'Paper 2',
        startsAt: now + 14 * DAY_MS,
      });
    }
    if (name === 'Mathematics AA HL') {
      repo.createExam(conn, user.id, {
        subjectId: subject.id, title: 'Maths AA HL Paper 1', component: 'Paper 1',
        startsAt: now + 26 * DAY_MS,
      });
    }
  }

  const subjects = repo.listSubjects(conn, user.id);
  const physics = subjects.find((s) => s.name === 'Physics HL')!;
  const maths = subjects.find((s) => s.name === 'Mathematics AA HL')!;
  const cs = subjects.find((s) => s.name === 'Computer Science HL')!;

  const lab = repo.createTask(conn, user.id, {
    title: 'Momentum lab: collect data', subjectId: physics.id, estimateMin: 90, priority: 1,
    dueAt: now + 2 * DAY_MS,
  });
  repo.createTask(conn, user.id, {
    title: 'Momentum lab: write up analysis', subjectId: physics.id, estimateMin: 120, priority: 1,
    dueAt: now + 4 * DAY_MS, dependsOn: [lab.id],
  });
  repo.createTask(conn, user.id, {
    title: 'Past paper: Maths AA HL P1 2023', subjectId: maths.id, estimateMin: 120, priority: 2,
    dueAt: now + 3 * DAY_MS,
  });
  repo.createTask(conn, user.id, {
    title: 'Integration by parts — 20 questions', subjectId: maths.id, estimateMin: 60, priority: 2,
    dueAt: now + DAY_MS,
  });
  repo.createTask(conn, user.id, {
    title: 'Implement a binary search tree', subjectId: cs.id, estimateMin: 75, priority: 3,
    dueAt: now + 6 * DAY_MS,
  });
  const done = repo.createTask(conn, user.id, {
    title: 'Read Chapter 4: Wave behaviour', subjectId: physics.id, estimateMin: 45, priority: 3,
  });
  repo.completeTask(conn, user.id, done.id, now - 3 * 3_600_000);

  // Recorded activity for the last ten days, with realistic gaps and one
  // genuine multi-device overlap so the overlap handling is visible.
  let seq = 0;
  for (let d = 9; d >= 0; d--) {
    if (d === 4 || d === 7) continue; // rest days
    const dayStart = now - d * DAY_MS;
    const blocks: Array<[number, number, string, string | undefined]> = [
      [0, 95, 'deep_study', physics.id],
      [100, 20, 'break', undefined],
      [125, 55, 'practice', maths.id],
      [190, 40, 'revision', d % 2 === 0 ? maths.id : physics.id],
    ];
    if (d % 3 === 0) blocks.push([240, 35, 'programming', cs.id]);
    if (d === 1) blocks.push([300, 25, 'distraction', undefined]);

    for (const [offsetMin, lengthMin, category, subjectId] of blocks) {
      const startedAt = dayStart + offsetMin * 60_000;
      const endedAt = startedAt + lengthMin * 60_000;
      repo.recordEvent(conn, user.id, {
        id: `seed_evt_${seq++}`,
        deviceId: 'demo-laptop',
        startedAt,
        endedAt,
        activeMs: Math.round(lengthMin * 60_000 * (category === 'break' ? 0.2 : 0.86)),
        category: category as never,
        provenance: 'measured',
        subjectId,
        taskId: d === 0 && category === 'deep_study' ? lab.id : undefined,
      });
    }
    if (d === 2) {
      // Phone revision overlapping the laptop session: the aggregate must count
      // this hour once, and say that it tie-broke the attribution.
      repo.recordEvent(conn, user.id, {
        id: `seed_evt_${seq++}`,
        deviceId: 'demo-phone',
        startedAt: dayStart + 130 * 60_000,
        endedAt: dayStart + 160 * 60_000,
        activeMs: 24 * 60_000,
        category: 'revision',
        provenance: 'measured',
        subjectId: physics.id,
      });
    }
  }

  // Practice attempts, including wrong answers that open mistake entries.
  const attemptPlan: Array<[string, boolean, string | undefined]> = [
    ['Physics HL/Forces and momentum', false, 'force diagram: missed normal reaction'],
    ['Physics HL/Forces and momentum', false, 'sign error resolving components'],
    ['Physics HL/Forces and momentum', true, undefined],
    ['Physics HL/Kinematics', true, undefined],
    ['Physics HL/Kinematics', true, undefined],
    ['Physics HL/Kinematics', true, undefined],
    ['Mathematics AA HL/Integration', false, 'forgot the constant of integration'],
    ['Mathematics AA HL/Integration', true, undefined],
    ['Mathematics AA HL/Integration', true, undefined],
    ['Mathematics AA HL/Differentiation', true, undefined],
    ['Mathematics AA HL/Differentiation', true, undefined],
    ['Mathematics AA HL/Differentiation', true, undefined],
    ['Mathematics AA HL/Differentiation', true, undefined],
    ['Computer Science HL/Recursion', false, 'no base case'],
  ];
  attemptPlan.forEach(([key, correct, errorCategory], i) => {
    const topicId = topicIds[key];
    if (!topicId) return;
    repo.recordAttempt(conn, user.id, {
      topicId,
      attemptedAt: now - (i % 6) * DAY_MS - 4 * 3_600_000,
      correct,
      errorCategory,
      question: `${key.split('/')[1]} — practice question ${i + 1}`,
    });
  });

  // Free time for the next week: evenings, with a fixed lesson tomorrow.
  const blocks = [];
  for (let d = 0; d < 7; d++) {
    const dayStart = Math.floor((now + d * DAY_MS) / DAY_MS) * DAY_MS;
    blocks.push({ startsAt: dayStart + 16 * 3_600_000, endsAt: dayStart + 21 * 3_600_000 });
    if (d === 1) {
      blocks.push({
        startsAt: dayStart + 18 * 3_600_000,
        endsAt: dayStart + 19 * 3_600_000,
        fixed: true,
        label: 'Physics tutorial',
      });
    }
  }
  repo.setAvailability(conn, user.id, blocks, { from: now - DAY_MS, to: now + 8 * DAY_MS });

  repo.createNote(conn, user.id, {
    title: 'Momentum: what I keep getting wrong',
    body: 'In collision questions, write the momentum equation before touching energy. Elastic means kinetic energy is conserved as well as momentum; inelastic means only momentum. The sign convention has to be fixed before substituting numbers — that is where the marks go.',
    topicId: topicIds['Physics HL/Forces and momentum'],
  });
  repo.createNote(conn, user.id, {
    title: 'Integration by parts',
    body: 'Choose u by LIATE: logarithmic, inverse trig, algebraic, trigonometric, exponential. Differentiate the earlier one. Always add the constant of integration.',
    topicId: topicIds['Mathematics AA HL/Integration'],
  });
}
