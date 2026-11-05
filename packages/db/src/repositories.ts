/**
 * Repositories: the only place SQL touches the domain.
 *
 * Every read that returns user data takes a `userId` and filters on it. That
 * is the single-tenant equivalent of the row-level security policies the
 * hosted deployment uses, and `isolation.test.ts` asserts it holds.
 */

import type {
  ActivityEvent,
  Exam,
  PracticeAttempt,
  RevisionState,
  ReviewGrade,
  Task,
  AvailabilityBlock,
} from '@studyos/core';
import { applyReview, DAY_MS, DEFAULT_PARAMS, type FsrsParams } from '@studyos/core';
import type { RevisionCard } from '@studyos/core';
import { newId, transaction, type Db } from './client.ts';

// ---------- users, subjects, topics ----------

export interface UserRow {
  id: string;
  email: string | null;
  display_name: string;
  timezone: string;
  created_at: number;
}

export function createUser(
  db: Db,
  input: { displayName: string; email?: string; timezone?: string },
): UserRow {
  const id = newId('usr');
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (id, email, display_name, timezone, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, input.email ?? null, input.displayName, input.timezone ?? 'UTC', now);
  return getUser(db, id)!;
}

export function getUser(db: Db, userId: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
}

export function createSubject(
  db: Db,
  userId: string,
  input: { name: string; curriculum?: string; level?: string; colour?: string },
): { id: string; name: string } {
  const id = newId('sub');
  db.prepare(
    `INSERT INTO subjects (id, user_id, name, curriculum, level, colour, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    input.name,
    input.curriculum ?? null,
    input.level ?? null,
    input.colour ?? null,
    Date.now(),
  );
  return { id, name: input.name };
}

export function listSubjects(db: Db, userId: string): Array<{ id: string; name: string; curriculum: string | null; level: string | null; colour: string | null }> {
  return db
    .prepare(
      `SELECT id, name, curriculum, level, colour FROM subjects
       WHERE user_id = ? AND archived_at IS NULL ORDER BY name`,
    )
    .all(userId) as any;
}

export function createTopic(
  db: Db,
  input: { subjectId: string; name: string; unitId?: string; position?: number },
): { id: string } {
  const id = newId('top');
  db.prepare(
    `INSERT INTO topics (id, subject_id, unit_id, name, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.subjectId, input.unitId ?? null, input.name, input.position ?? 0, Date.now());
  return { id };
}

export function listTopics(
  db: Db,
  userId: string,
  subjectId?: string,
): Array<{ id: string; name: string; subject_id: string }> {
  const sql = `SELECT t.id, t.name, t.subject_id FROM topics t
     JOIN subjects s ON s.id = t.subject_id
     WHERE s.user_id = ?${subjectId ? ' AND t.subject_id = ?' : ''}
     ORDER BY t.position, t.name`;
  const stmt = db.prepare(sql);
  return (subjectId ? stmt.all(userId, subjectId) : stmt.all(userId)) as any;
}

// ---------- tasks ----------

export function createTask(
  db: Db,
  userId: string,
  input: Omit<Task, 'id' | 'actualMin' | 'completedAt'> & { notes?: string },
): Task {
  const id = newId('tsk');
  const now = Date.now();
  return transaction(db, () => {
    db.prepare(
      `INSERT INTO tasks (id, user_id, workspace_id, subject_id, topic_id, title, notes,
                          estimate_min, actual_min, due_at, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    ).run(
      id,
      userId,
      input.workspaceId ?? null,
      input.subjectId ?? null,
      input.topicId ?? null,
      input.title,
      input.notes ?? null,
      input.estimateMin,
      input.dueAt ?? null,
      input.priority,
      now,
      now,
    );
    for (const dep of input.dependsOn ?? []) {
      db.prepare('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on) VALUES (?, ?)').run(
        id,
        dep,
      );
    }
    return getTask(db, userId, id)!;
  });
}

function rowToTask(row: any, deps: string[]): Task {
  return {
    id: row.id,
    title: row.title,
    subjectId: row.subject_id ?? undefined,
    topicId: row.topic_id ?? undefined,
    estimateMin: row.estimate_min,
    actualMin: row.actual_min,
    dueAt: row.due_at ?? undefined,
    priority: row.priority,
    dependsOn: deps.length > 0 ? deps : undefined,
    completedAt: row.completed_at ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
  };
}

export function getTask(db: Db, userId: string, taskId: string): Task | undefined {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(taskId, userId);
  if (!row) return undefined;
  const deps = (
    db.prepare('SELECT depends_on FROM task_dependencies WHERE task_id = ?').all(taskId) as Array<{
      depends_on: string;
    }>
  ).map((r) => r.depends_on);
  return rowToTask(row, deps);
}

export function listTasks(
  db: Db,
  userId: string,
  opts: { includeCompleted?: boolean } = {},
): Task[] {
  const rows = db
    .prepare(
      `SELECT * FROM tasks WHERE user_id = ?${opts.includeCompleted ? '' : ' AND completed_at IS NULL'}
       ORDER BY COALESCE(due_at, 9e15), priority`,
    )
    .all(userId) as any[];
  const deps = db
    .prepare(
      `SELECT d.task_id, d.depends_on FROM task_dependencies d
       JOIN tasks t ON t.id = d.task_id WHERE t.user_id = ?`,
    )
    .all(userId) as Array<{ task_id: string; depends_on: string }>;
  const byTask = new Map<string, string[]>();
  for (const d of deps) {
    const list = byTask.get(d.task_id);
    if (list) list.push(d.depends_on);
    else byTask.set(d.task_id, [d.depends_on]);
  }
  return rows.map((r) => rowToTask(r, byTask.get(r.id) ?? []));
}

export function completeTask(db: Db, userId: string, taskId: string, at = Date.now()): boolean {
  const res = db
    .prepare('UPDATE tasks SET completed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(at, at, taskId, userId);
  return res.changes > 0;
}

export function reopenTask(db: Db, userId: string, taskId: string): boolean {
  const res = db
    .prepare('UPDATE tasks SET completed_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(Date.now(), taskId, userId);
  return res.changes > 0;
}

// ---------- activity events ----------

export function recordEvent(db: Db, userId: string, event: ActivityEvent): ActivityEvent {
  db.prepare(
    `INSERT INTO activity_events (id, user_id, device_id, started_at, ended_at, active_ms,
       category, provenance, subject_id, topic_id, task_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(
    event.id,
    userId,
    event.deviceId,
    event.startedAt,
    event.endedAt,
    event.activeMs,
    event.category,
    event.provenance,
    event.subjectId ?? null,
    event.topicId ?? null,
    event.taskId ?? null,
    event.note ?? null,
    Date.now(),
  );
  // Keep the task's actual_min in step with what was recorded against it.
  if (event.taskId) {
    db.prepare(
      `UPDATE tasks SET actual_min = (
         SELECT COALESCE(SUM(ended_at - started_at), 0) / 60000 FROM activity_events
         WHERE task_id = ? AND user_id = ?
       ), updated_at = ? WHERE id = ? AND user_id = ?`,
    ).run(event.taskId, userId, Date.now(), event.taskId, userId);
  }
  return event;
}

export function listEvents(db: Db, userId: string, from: number, to: number): ActivityEvent[] {
  const rows = db
    .prepare(
      `SELECT * FROM activity_events
       WHERE user_id = ? AND ended_at > ? AND started_at < ?
         AND id NOT IN (SELECT supersedes_id FROM activity_events WHERE supersedes_id IS NOT NULL)
       ORDER BY started_at`,
    )
    .all(userId, from, to) as any[];
  return rows.map((r) => ({
    id: r.id,
    deviceId: r.device_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    activeMs: r.active_ms,
    category: r.category,
    provenance: r.provenance,
    subjectId: r.subject_id ?? undefined,
    topicId: r.topic_id ?? undefined,
    taskId: r.task_id ?? undefined,
    correctedAt: r.corrected_at ?? undefined,
    note: r.note ?? undefined,
  }));
}

/**
 * Correct a recorded event by superseding it. The original row stays, so the
 * history remains auditable — "allow auditable corrections", not silent edits.
 */
export function correctEvent(
  db: Db,
  userId: string,
  originalId: string,
  patch: Partial<Pick<ActivityEvent, 'category' | 'subjectId' | 'topicId' | 'note' | 'activeMs'>>,
): ActivityEvent | undefined {
  const original = db
    .prepare('SELECT * FROM activity_events WHERE id = ? AND user_id = ?')
    .get(originalId, userId) as any;
  if (!original) return undefined;

  const now = Date.now();
  const id = newId('evt');
  return transaction(db, () => {
    db.prepare(
      `INSERT INTO activity_events (id, user_id, device_id, started_at, ended_at, active_ms,
         category, provenance, subject_id, topic_id, task_id, supersedes_id, corrected_at, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      userId,
      original.device_id,
      original.started_at,
      original.ended_at,
      patch.activeMs ?? original.active_ms,
      patch.category ?? original.category,
      patch.subjectId ?? original.subject_id,
      patch.topicId ?? original.topic_id,
      original.task_id,
      originalId,
      now,
      patch.note ?? original.note,
      now,
    );
    db.prepare(
      `INSERT INTO audit_log (id, user_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(newId('aud'), userId, 'event.corrected', JSON.stringify({ originalId, id, patch }), now);
    return listEvents(db, userId, original.started_at, original.ended_at).find((e) => e.id === id);
  });
}

// ---------- revision ----------

export function createCard(
  db: Db,
  userId: string,
  input: { topicId: string; front: string; back: string; source?: string; dueAt?: number },
): { id: string } {
  const id = newId('crd');
  const now = Date.now();
  return transaction(db, () => {
    db.prepare(
      `INSERT INTO flashcards (id, user_id, topic_id, front, back, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, userId, input.topicId, input.front, input.back, input.source ?? null, now);
    db.prepare(
      `INSERT INTO revision_states (card_id, stability, difficulty, last_reviewed_at, due_at, reps, lapses)
       VALUES (?, ?, ?, NULL, ?, 0, 0)`,
      // A new card has no memory trace yet; the first review sets both.
    ).run(id, 0, 5, input.dueAt ?? now);
    return { id };
  });
}

export function getUserFsrsParams(db: Db, userId: string): FsrsParams {
  const row = db.prepare('SELECT * FROM revision_params WHERE user_id = ?').get(userId) as any;
  if (!row) return DEFAULT_PARAMS;
  return {
    weights: row.weights_json ? JSON.parse(row.weights_json) : DEFAULT_PARAMS.weights,
    desiredRetention: row.desired_retention,
    maximumInterval: row.maximum_interval,
  };
}

export function listRevisionCards(db: Db, userId: string): RevisionCard[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.topic_id, t.subject_id, r.stability, r.difficulty, r.last_reviewed_at,
              r.due_at, r.reps, r.lapses,
              EXISTS (SELECT 1 FROM mistakes m
                      WHERE m.topic_id = c.topic_id AND m.resolved_at IS NULL
                        AND m.user_id = c.user_id) AS flagged
       FROM flashcards c
       JOIN revision_states r ON r.card_id = c.id
       JOIN topics t ON t.id = c.topic_id
       WHERE c.user_id = ?`,
    )
    .all(userId) as any[];
  return rows.map((r) => ({
    id: r.id,
    topicId: r.topic_id,
    subjectId: r.subject_id,
    flaggedByMistake: Boolean(r.flagged),
    state: {
      stability: r.stability,
      difficulty: r.difficulty,
      lastReviewedAt: r.last_reviewed_at ?? undefined,
      dueAt: r.due_at,
      reps: r.reps,
      lapses: r.lapses,
    },
  }));
}

/**
 * Grade a card: advance its FSRS state and append to the review log, in one
 * transaction so the log can never disagree with the state.
 */
export function gradeCard(
  db: Db,
  userId: string,
  cardId: string,
  grade: ReviewGrade,
  reviewedAt = Date.now(),
): { state: RevisionState; intervalDays: number } | undefined {
  const row = db
    .prepare(
      `SELECT r.* FROM revision_states r JOIN flashcards c ON c.id = r.card_id
       WHERE r.card_id = ? AND c.user_id = ?`,
    )
    .get(cardId, userId) as any;
  if (!row) return undefined;

  const prior: RevisionState = {
    stability: row.stability,
    difficulty: row.difficulty,
    lastReviewedAt: row.last_reviewed_at ?? undefined,
    dueAt: row.due_at,
    reps: row.reps,
    lapses: row.lapses,
  };
  const params = getUserFsrsParams(db, userId);
  const outcome = applyReview(prior.reps === 0 ? undefined : prior, grade, reviewedAt, params);

  return transaction(db, () => {
    db.prepare(
      `UPDATE revision_states SET stability = ?, difficulty = ?, last_reviewed_at = ?,
         due_at = ?, reps = ?, lapses = ? WHERE card_id = ?`,
    ).run(
      outcome.state.stability,
      outcome.state.difficulty,
      outcome.state.lastReviewedAt ?? null,
      outcome.state.dueAt,
      outcome.state.reps,
      outcome.state.lapses,
      cardId,
    );
    db.prepare(
      `INSERT INTO review_log (id, card_id, reviewed_at, grade, elapsed_days,
         stability_before, stability_after, difficulty_after, interval_days, retrievability)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId('rvw'),
      cardId,
      reviewedAt,
      grade,
      prior.lastReviewedAt ? (reviewedAt - prior.lastReviewedAt) / DAY_MS : 0,
      prior.reps === 0 ? null : prior.stability,
      outcome.state.stability,
      outcome.state.difficulty,
      outcome.intervalDays,
      outcome.retrievabilityAtReview,
    );
    return { state: outcome.state, intervalDays: outcome.intervalDays };
  });
}

export function listReviewTimestamps(db: Db, userId: string, from: number, to: number): number[] {
  return (
    db
      .prepare(
        `SELECT l.reviewed_at FROM review_log l JOIN flashcards c ON c.id = l.card_id
         WHERE c.user_id = ? AND l.reviewed_at >= ? AND l.reviewed_at < ?`,
      )
      .all(userId, from, to) as Array<{ reviewed_at: number }>
  ).map((r) => r.reviewed_at);
}

// ---------- practice and mistakes ----------

export function recordAttempt(
  db: Db,
  userId: string,
  input: Omit<PracticeAttempt, 'id'> & {
    question?: string;
    givenAnswer?: string;
    correctAnswer?: string;
    /** Auto-create a mistake-notebook entry when the answer was wrong. */
    logMistake?: boolean;
  },
): PracticeAttempt {
  const id = newId('att');
  return transaction(db, () => {
    db.prepare(
      `INSERT INTO practice_attempts (id, user_id, topic_id, question, given_answer,
         correct_answer, correct, score, error_category, attempted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      userId,
      input.topicId,
      input.question ?? null,
      input.givenAnswer ?? null,
      input.correctAnswer ?? null,
      input.correct ? 1 : 0,
      input.score ?? null,
      input.errorCategory ?? null,
      input.attemptedAt,
    );
    if (!input.correct && input.logMistake !== false) {
      db.prepare(
        `INSERT INTO mistakes (id, user_id, attempt_id, topic_id, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        newId('mis'),
        userId,
        id,
        input.topicId,
        input.question ?? 'Incorrect practice answer',
        Date.now(),
      );
    }
    return {
      id,
      topicId: input.topicId,
      attemptedAt: input.attemptedAt,
      correct: input.correct,
      score: input.score,
      errorCategory: input.errorCategory,
    };
  });
}

export function listAttempts(db: Db, userId: string, topicId?: string): PracticeAttempt[] {
  const sql = `SELECT * FROM practice_attempts WHERE user_id = ?${topicId ? ' AND topic_id = ?' : ''} ORDER BY attempted_at DESC`;
  const stmt = db.prepare(sql);
  const rows = (topicId ? stmt.all(userId, topicId) : stmt.all(userId)) as any[];
  return rows.map((r) => ({
    id: r.id,
    topicId: r.topic_id,
    attemptedAt: r.attempted_at,
    correct: Boolean(r.correct),
    score: r.score ?? undefined,
    errorCategory: r.error_category ?? undefined,
  }));
}

export function countOpenMistakes(db: Db, userId: string, topicId: string): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM mistakes WHERE user_id = ? AND topic_id = ? AND resolved_at IS NULL',
    )
    .get(userId, topicId) as { n: number };
  return row.n;
}

export function resolveMistake(db: Db, userId: string, mistakeId: string): boolean {
  return (
    db
      .prepare('UPDATE mistakes SET resolved_at = ? WHERE id = ? AND user_id = ?')
      .run(Date.now(), mistakeId, userId).changes > 0
  );
}

export function listMistakes(
  db: Db,
  userId: string,
  opts: { openOnly?: boolean } = {},
): Array<{ id: string; topicId: string; summary: string; createdAt: number; resolvedAt?: number }> {
  const rows = db
    .prepare(
      `SELECT * FROM mistakes WHERE user_id = ?${opts.openOnly ? ' AND resolved_at IS NULL' : ''}
       ORDER BY created_at DESC`,
    )
    .all(userId) as any[];
  return rows.map((r) => ({
    id: r.id,
    topicId: r.topic_id,
    summary: r.summary,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at ?? undefined,
  }));
}

// ---------- exams, availability ----------

export function createExam(db: Db, userId: string, input: Omit<Exam, 'id'>): Exam {
  const id = newId('exm');
  db.prepare(
    `INSERT INTO exams (id, user_id, subject_id, title, component, starts_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, input.subjectId, input.title, input.component ?? null, input.startsAt, Date.now());
  return { id, ...input };
}

export function listExams(db: Db, userId: string): Exam[] {
  const rows = db
    .prepare('SELECT * FROM exams WHERE user_id = ? ORDER BY starts_at')
    .all(userId) as any[];
  return rows.map((r) => ({
    id: r.id,
    subjectId: r.subject_id,
    title: r.title,
    component: r.component ?? undefined,
    startsAt: r.starts_at,
  }));
}

export function setAvailability(
  db: Db,
  userId: string,
  blocks: readonly AvailabilityBlock[],
  window: { from: number; to: number },
): void {
  transaction(db, () => {
    db.prepare(
      'DELETE FROM availability WHERE user_id = ? AND starts_at >= ? AND starts_at < ?',
    ).run(userId, window.from, window.to);
    for (const b of blocks) {
      db.prepare(
        `INSERT INTO availability (id, user_id, starts_at, ends_at, fixed, label)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(newId('avl'), userId, b.startsAt, b.endsAt, b.fixed ? 1 : 0, b.label ?? null);
    }
  });
}

export function listAvailability(
  db: Db,
  userId: string,
  from: number,
  to: number,
): AvailabilityBlock[] {
  const rows = db
    .prepare(
      'SELECT * FROM availability WHERE user_id = ? AND ends_at > ? AND starts_at < ? ORDER BY starts_at',
    )
    .all(userId, from, to) as any[];
  return rows.map((r) => ({
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    fixed: Boolean(r.fixed),
    label: r.label ?? undefined,
  }));
}

// ---------- notes ----------

export function createNote(
  db: Db,
  userId: string,
  input: { title: string; body?: string; topicId?: string },
): { id: string } {
  const id = newId('nte');
  const now = Date.now();
  db.prepare(
    `INSERT INTO notes (id, user_id, topic_id, title, body, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, input.topicId ?? null, input.title, input.body ?? '', now, now);
  return { id };
}

export function updateNote(db: Db, userId: string, noteId: string, body: string): boolean {
  const existing = db
    .prepare('SELECT body FROM notes WHERE id = ? AND user_id = ?')
    .get(noteId, userId) as { body: string } | undefined;
  if (!existing) return false;
  return transaction(db, () => {
    // Snapshot the previous body first, so edits are never destructive.
    db.prepare(
      'INSERT INTO note_versions (id, note_id, body, created_at) VALUES (?, ?, ?, ?)',
    ).run(newId('nve'), noteId, existing.body, Date.now());
    db.prepare('UPDATE notes SET body = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(
      body,
      Date.now(),
      noteId,
      userId,
    );
    return true;
  });
}

export function searchNotes(
  db: Db,
  userId: string,
  query: string,
): Array<{ id: string; title: string; snippet: string }> {
  if (!query.trim()) return [];
  return db
    .prepare(
      `SELECT n.id, n.title, snippet(notes_fts, 1, '[', ']', '…', 12) AS snippet
       FROM notes_fts f JOIN notes n ON n.rowid = f.rowid
       WHERE notes_fts MATCH ? AND n.user_id = ?
       ORDER BY rank LIMIT 25`,
    )
    .all(query, userId) as any;
}

export function listNoteVersions(db: Db, userId: string, noteId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM note_versions v JOIN notes n ON n.id = v.note_id
       WHERE v.note_id = ? AND n.user_id = ?`,
    )
    .get(noteId, userId) as { n: number };
  return row.n;
}

// ---------- sync, export, deletion ----------

/**
 * Apply a queued offline mutation. Idempotent on (device_id, seq): replaying
 * the same mutation is a no-op rather than a duplicate, which is what makes
 * at-least-once delivery safe.
 */
export function enqueueMutation(
  db: Db,
  userId: string,
  input: { deviceId: string; seq: number; entity: string; op: 'upsert' | 'delete'; payload: unknown },
): { accepted: boolean; duplicate: boolean } {
  const existing = db
    .prepare('SELECT id FROM sync_queue WHERE device_id = ? AND seq = ?')
    .get(input.deviceId, input.seq);
  if (existing) return { accepted: false, duplicate: true };

  db.prepare(
    `INSERT INTO sync_queue (id, user_id, device_id, seq, entity, op, payload, queued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId('syn'),
    userId,
    input.deviceId,
    input.seq,
    input.entity,
    input.op,
    JSON.stringify(input.payload),
    Date.now(),
  );
  return { accepted: true, duplicate: false };
}

export function markMutationApplied(db: Db, id: string, error?: string): void {
  db.prepare('UPDATE sync_queue SET applied_at = ?, error = ? WHERE id = ?').run(
    Date.now(),
    error ?? null,
    id,
  );
}

export function pendingMutations(db: Db, userId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM sync_queue WHERE user_id = ? AND applied_at IS NULL')
    .get(userId) as { n: number };
  return row.n;
}

/** Tables that hold user-owned data, in the order a full export walks them. */
const USER_TABLES = [
  'users', 'devices', 'workspaces', 'subjects', 'units', 'topics', 'tasks',
  'task_dependencies', 'activity_events', 'focus_sessions', 'notes', 'note_versions',
  'flashcards', 'revision_states', 'review_log', 'practice_attempts', 'mistakes',
  'exams', 'availability', 'daily_reports', 'sync_queue', 'audit_log', 'revision_params',
] as const;

/** Complete machine-readable export of everything stored about one user. */
export function exportUserData(db: Db, userId: string): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  out.users = db.prepare('SELECT * FROM users WHERE id = ?').all(userId);
  out.devices = db.prepare('SELECT * FROM devices WHERE user_id = ?').all(userId);
  out.workspaces = db.prepare('SELECT * FROM workspaces WHERE user_id = ?').all(userId);
  out.subjects = db.prepare('SELECT * FROM subjects WHERE user_id = ?').all(userId);
  out.units = db
    .prepare('SELECT u.* FROM units u JOIN subjects s ON s.id = u.subject_id WHERE s.user_id = ?')
    .all(userId);
  out.topics = db
    .prepare('SELECT t.* FROM topics t JOIN subjects s ON s.id = t.subject_id WHERE s.user_id = ?')
    .all(userId);
  out.tasks = db.prepare('SELECT * FROM tasks WHERE user_id = ?').all(userId);
  out.task_dependencies = db
    .prepare('SELECT d.* FROM task_dependencies d JOIN tasks t ON t.id = d.task_id WHERE t.user_id = ?')
    .all(userId);
  out.activity_events = db.prepare('SELECT * FROM activity_events WHERE user_id = ?').all(userId);
  out.focus_sessions = db.prepare('SELECT * FROM focus_sessions WHERE user_id = ?').all(userId);
  out.notes = db.prepare('SELECT * FROM notes WHERE user_id = ?').all(userId);
  out.note_versions = db
    .prepare('SELECT v.* FROM note_versions v JOIN notes n ON n.id = v.note_id WHERE n.user_id = ?')
    .all(userId);
  out.flashcards = db.prepare('SELECT * FROM flashcards WHERE user_id = ?').all(userId);
  out.revision_states = db
    .prepare('SELECT r.* FROM revision_states r JOIN flashcards c ON c.id = r.card_id WHERE c.user_id = ?')
    .all(userId);
  out.review_log = db
    .prepare('SELECT l.* FROM review_log l JOIN flashcards c ON c.id = l.card_id WHERE c.user_id = ?')
    .all(userId);
  out.practice_attempts = db.prepare('SELECT * FROM practice_attempts WHERE user_id = ?').all(userId);
  out.mistakes = db.prepare('SELECT * FROM mistakes WHERE user_id = ?').all(userId);
  out.exams = db.prepare('SELECT * FROM exams WHERE user_id = ?').all(userId);
  out.availability = db.prepare('SELECT * FROM availability WHERE user_id = ?').all(userId);
  out.daily_reports = db.prepare('SELECT * FROM daily_reports WHERE user_id = ?').all(userId);
  out.sync_queue = db.prepare('SELECT * FROM sync_queue WHERE user_id = ?').all(userId);
  out.audit_log = db.prepare('SELECT * FROM audit_log WHERE user_id = ?').all(userId);
  out.revision_params = db.prepare('SELECT * FROM revision_params WHERE user_id = ?').all(userId);
  return out;
}

/**
 * Delete a user and everything belonging to them. Relies on ON DELETE CASCADE,
 * which only works because openDb() enables foreign keys — verified by test.
 */
export function deleteUser(db: Db, userId: string): { deleted: boolean } {
  const res = db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  return { deleted: res.changes > 0 };
}

/** Rows still referencing a user id. Used to prove deletion was complete. */
export function residualRowCount(db: Db, userId: string): number {
  let total = 0;
  for (const table of USER_TABLES) {
    const hasUserId = (
      db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = 'user_id'`).get(table) as {
        n: number;
      }
    ).n;
    if (table === 'users') {
      total += (db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(userId) as { n: number }).n;
    } else if (hasUserId) {
      total += (
        db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(userId) as { n: number }
      ).n;
    }
  }
  return total;
}
