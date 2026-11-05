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

  /**
   * Per-topic learning profiles. Hand-set rather than random so the seeded
   * student is *legible*: the knowledge graph needs solid topics, decayed
   * topics and untouched topics to exist side by side, or its colour scale
   * and its gap analysis have nothing to distinguish.
   */
  type Profile = 'mastered' | 'strong' | 'practising' | 'learning' | 'needs_revision' | 'not_started';

  const plan: Array<[string, string, Array<[string, Profile]>]> = [
    ['Physics HL', 'IB DP', [
      ['Kinematics', 'strong'],
      ['Forces and momentum', 'needs_revision'],
      ['Work and energy', 'practising'],
      ['Wave behaviour', 'not_started'],
    ]],
    ['Mathematics AA HL', 'IB DP', [
      ['Differentiation', 'mastered'],
      ['Integration', 'practising'],
      ['Vectors', 'needs_revision'],
      ['Complex numbers', 'not_started'],
    ]],
    ['Computer Science HL', 'IB DP', [
      ['Recursion', 'needs_revision'],
      ['Abstract data structures', 'not_started'],
      ['Databases', 'learning'],
    ]],
    ['Economics SL', 'IB DP', [
      ['Elasticity', 'needs_revision'],
      ['Market failure', 'not_started'],
      ['Macro objectives', 'not_started'],
    ]],
  ];

  /**
   * Review histories that actually produce the intended state through FSRS,
   * rather than being written into the database as a label. Days are offsets
   * back from now; grades are Again(1)/Hard(2)/Good(3).
   */
  const REVIEW_HISTORY: Record<Profile, Array<[number, 1 | 2 | 3]>> = {
    mastered: [[70, 3], [50, 3], [22, 3], [3, 3]],
    strong: [[60, 3], [40, 3], [16, 3], [4, 3]],
    practising: [[35, 3], [14, 3], [5, 3]],
    learning: [[24, 2], [7, 2]],
    // Reviewed, then lapsed, then left alone: low stability and long elapsed
    // time, which is what actually drives retention below the floor.
    needs_revision: [[55, 3], [38, 1]],
    not_started: [],
  };

  /** [total attempts, correct attempts, days to spread them across]. */
  const ATTEMPTS: Record<Profile, [number, number, number]> = {
    mastered: [12, 12, 4],
    strong: [8, 7, 3],
    practising: [8, 5, 3],
    learning: [4, 1, 2],
    needs_revision: [3, 1, 2],
    not_started: [0, 0, 1],
  };

  const topicIds: Record<string, string> = {};
  const topicProfiles: Array<[string, string, Profile]> = [];

  for (const [name, curriculum, topics] of plan) {
    const subject = repo.createSubject(conn, user.id, {
      name,
      curriculum,
      level: name.endsWith('HL') ? 'HL' : 'SL',
    });
    topics.forEach(([topicName, profile], i) => {
      const { id } = repo.createTopic(conn, { subjectId: subject.id, name: topicName, position: i });
      const key = `${name}/${topicName}`;
      topicIds[key] = id;
      topicProfiles.push([key, id, profile]);

      for (let c = 0; c < 2; c++) {
        const { id: cardId } = repo.createCard(conn, user.id, {
          topicId: id,
          front: `${topicName}: recall prompt ${c + 1}`,
          back: `Worked answer for ${topicName} (${c + 1})`,
        });
        // Replay the history through the real scheduler, so stability and due
        // dates are genuine FSRS output rather than invented numbers.
        for (const [daysAgo, grade] of REVIEW_HISTORY[profile]) {
          repo.gradeCard(conn, user.id, cardId, grade, now - daysAgo * DAY_MS);
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

  for (const [key, topicId, profile] of topicProfiles) {
    const [total, correct, spreadDays] = ATTEMPTS[profile];
    for (let i = 0; i < total; i++) {
      const isCorrect = i < correct;
      repo.recordAttempt(conn, user.id, {
        topicId,
        attemptedAt: now - (i % spreadDays) * DAY_MS - 5 * 3_600_000,
        correct: isCorrect,
        errorCategory: isCorrect ? undefined : 'see mistake notebook',
        question: `${key.split('/')[1]} — practice question ${i + 1}`,
        // Historical wrong answers on topics the student has since worked
        // through are logged as attempts without leaving the mistake open;
        // only the genuinely weak topics keep unresolved entries.
        logMistake: profile === 'needs_revision',
      });
    }
  }

  // Prerequisite structure for the knowledge graph. Cross-subject edges are
  // deliberate: calculus really does underpin kinematics, and the graph should
  // show that rather than pretending subjects are independent silos.
  const links: Array<[string, string, 'prerequisite' | 'related']> = [
    ['Physics HL/Kinematics', 'Physics HL/Forces and momentum', 'prerequisite'],
    ['Physics HL/Forces and momentum', 'Physics HL/Work and energy', 'prerequisite'],
    ['Mathematics AA HL/Differentiation', 'Mathematics AA HL/Integration', 'prerequisite'],
    ['Mathematics AA HL/Differentiation', 'Physics HL/Kinematics', 'prerequisite'],
    ['Mathematics AA HL/Vectors', 'Physics HL/Forces and momentum', 'prerequisite'],
    ['Mathematics AA HL/Integration', 'Physics HL/Work and energy', 'prerequisite'],
    ['Computer Science HL/Recursion', 'Computer Science HL/Abstract data structures', 'prerequisite'],
    ['Economics SL/Elasticity', 'Economics SL/Market failure', 'prerequisite'],
    ['Economics SL/Elasticity', 'Economics SL/Macro objectives', 'prerequisite'],
    ['Mathematics AA HL/Vectors', 'Mathematics AA HL/Complex numbers', 'related'],
    ['Physics HL/Wave behaviour', 'Mathematics AA HL/Complex numbers', 'related'],
  ];
  for (const [from, to, kind] of links) {
    const fromId = topicIds[from];
    const toId = topicIds[to];
    if (fromId && toId) {
      repo.createTopicLink(conn, user.id, { fromTopicId: fromId, toTopicId: toId, kind });
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

  const notes: Array<{ title: string; body: string; topic?: string }> = [
    {
      title: 'Momentum: what I keep getting wrong',
      body: 'In collision questions, write the momentum equation before touching energy. Elastic means kinetic energy is conserved as well as momentum; inelastic means only momentum. The sign convention has to be fixed before substituting numbers — that is where the marks go.',
      topic: 'Physics HL/Forces and momentum',
    },
    {
      title: 'Integration by parts',
      body: 'Choose u by LIATE: logarithmic, inverse trig, algebraic, trigonometric, exponential. Differentiate the earlier one. Always add the constant of integration.',
      topic: 'Mathematics AA HL/Integration',
    },
    {
      title: 'Projectile motion',
      body: 'Horizontal and vertical motion are independent; the only quantity they share is time.\n\nMy error was carrying g into the horizontal component. Horizontal velocity is constant, vertical acceleration is g downward. For range: solve the vertical equation for flight time, then multiply by horizontal velocity. Not in one step.',
      topic: 'Physics HL/Kinematics',
    },
    {
      title: 'Recursion: base case first',
      body: 'Write the base case before the recursive case, every time. Every infinite recursion I have written was a missing or unreachable base case, not a wrong recursive step.\n\nFor trees the base case is the null node, not the leaf.',
      topic: 'Computer Science HL/Recursion',
    },
    {
      title: 'PED and total revenue',
      body: 'Elastic demand (PED > 1): a price rise lowers total revenue. Inelastic (PED < 1): a price rise raises it. Unit elastic is the revenue maximum.\n\nPED is negative for normal demand, so compare magnitudes, not signed values.',
      topic: 'Economics SL/Elasticity',
    },
    {
      // Unattached on purpose: not every note belongs to a syllabus topic.
      title: 'Study log — week of 2 Nov',
      body: 'Mon: differentiation drills, fine.\nTue: momentum lab data, took longer than planned.\nWed: integration by parts, struggled.\nThu: revision queue only.\n\nPattern worth watching: the topics I avoid are the ones with the oldest cards.',
    },
  ];
  for (const note of notes) {
    repo.createNote(conn, user.id, {
      title: note.title,
      body: note.body,
      topicId: note.topic ? topicIds[note.topic] : undefined,
    });
  }

  // One note revised twice, so version history is populated rather than an
  // empty panel on a feature whose whole point is that edits are recoverable.
  const projectile = repo.listNotes(conn, user.id).find((n) => n.title === 'Projectile motion');
  if (projectile) {
    repo.updateNote(conn, user.id, projectile.id, {
      body: `${projectile.body}\n\nAfter the mock: check whether launch and landing heights are equal before using the symmetric range formula. Usually they are not.`,
    });
    const current = repo.getNote(conn, user.id, projectile.id)!;
    repo.updateNote(conn, user.id, projectile.id, {
      title: 'Projectile motion — what I kept getting wrong',
      body: `${current.body}\n\nWorked a past paper with a cliff launch and got it right by splitting the fall into two phases.`,
    });
  }
}
