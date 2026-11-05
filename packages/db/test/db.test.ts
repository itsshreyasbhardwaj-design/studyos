import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, newId, transaction, type Db } from '../src/client.ts';
import * as repo from '../src/repositories.ts';
import { DAY_MS } from '@studyos/core';

const NOW = Date.UTC(2026, 10, 5, 9, 0, 0);

function fresh(): { db: Db; userId: string } {
  const db = openDb({ path: ':memory:' });
  const user = repo.createUser(db, { displayName: 'Test Student', email: 't@example.com' });
  return { db, userId: user.id };
}

test('migrations run once and are idempotent', () => {
  const db = openDb({ path: ':memory:' });
  const second = migrate(db);
  assert.deepEqual(second, [], 'a second migrate() must be a no-op');
  const rows = db.prepare('SELECT id FROM _migrations ORDER BY id').all() as Array<{ id: string }>;
  assert.deepEqual(rows.map((r) => r.id), ['001_core', '002_fts_notes', '003_user_fsrs_params']);
});

test('foreign keys are enforced, so cascades actually work', () => {
  const { db, userId } = fresh();
  assert.throws(
    () => repo.createTopic(db, { subjectId: 'does-not-exist', name: 'Orphan' }),
    /FOREIGN KEY/i,
    'a topic under a missing subject must be rejected',
  );
  const { id: subjectId } = repo.createSubject(db, userId, { name: 'Maths' });
  repo.createTopic(db, { subjectId, name: 'Vectors' });
  db.prepare('DELETE FROM subjects WHERE id = ?').run(subjectId);
  const topics = db.prepare('SELECT COUNT(*) AS n FROM topics').get() as { n: number };
  assert.equal(topics.n, 0, 'topics must cascade with their subject');
});

test('schema rejects an event that ends before it starts', () => {
  const { db, userId } = fresh();
  assert.throws(
    () =>
      repo.recordEvent(db, userId, {
        id: newId('evt'),
        deviceId: 'laptop',
        startedAt: NOW,
        endedAt: NOW - 1000,
        activeMs: 0,
        category: 'deep_study',
        provenance: 'measured',
      }),
    /CHECK|constraint/i,
  );
});

test('schema rejects active time longer than the window it sits in', () => {
  const { db, userId } = fresh();
  assert.throws(
    () =>
      repo.recordEvent(db, userId, {
        id: newId('evt'),
        deviceId: 'laptop',
        startedAt: NOW,
        endedAt: NOW + 60_000,
        activeMs: 120_000,
        category: 'deep_study',
        provenance: 'measured',
      }),
    /CHECK|constraint/i,
  );
});

test('recording the same event id twice does not duplicate it', () => {
  const { db, userId } = fresh();
  const event = {
    id: 'fixed-id',
    deviceId: 'laptop',
    startedAt: NOW,
    endedAt: NOW + 3_600_000,
    activeMs: 3_000_000,
    category: 'deep_study' as const,
    provenance: 'measured' as const,
  };
  repo.recordEvent(db, userId, event);
  repo.recordEvent(db, userId, event);
  assert.equal(repo.listEvents(db, userId, NOW - DAY_MS, NOW + DAY_MS).length, 1);
});

test('time recorded against a task updates its actual minutes', () => {
  const { db, userId } = fresh();
  const task = repo.createTask(db, userId, { title: 'Problem set', estimateMin: 60, priority: 1 });
  repo.recordEvent(db, userId, {
    id: newId('evt'),
    deviceId: 'laptop',
    startedAt: NOW,
    endedAt: NOW + 1_800_000,
    activeMs: 1_800_000,
    category: 'deep_study',
    provenance: 'measured',
    taskId: task.id,
  });
  assert.equal(repo.getTask(db, userId, task.id)!.actualMin, 30);
});

test('correcting an event supersedes it and keeps the original for audit', () => {
  const { db, userId } = fresh();
  const original = repo.recordEvent(db, userId, {
    id: newId('evt'),
    deviceId: 'laptop',
    startedAt: NOW,
    endedAt: NOW + 3_600_000,
    activeMs: 3_600_000,
    category: 'deep_study',
    provenance: 'measured',
  });
  const corrected = repo.correctEvent(db, userId, original.id, { category: 'distraction' });
  assert.ok(corrected, 'correction must return the new event');
  assert.equal(corrected!.category, 'distraction');
  assert.equal(corrected!.provenance, 'confirmed');

  // The original row still exists, but reads return only the correction.
  const raw = db.prepare('SELECT COUNT(*) AS n FROM activity_events').get() as { n: number };
  assert.equal(raw.n, 2, 'history must be preserved');
  const visible = repo.listEvents(db, userId, NOW - DAY_MS, NOW + DAY_MS);
  assert.equal(visible.length, 1, 'superseded events must not be double-counted');
  assert.equal(visible[0].category, 'distraction');

  const audit = db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ?').get(userId) as { n: number };
  assert.equal(audit.n, 1);
});

test('grading a card advances FSRS state and appends exactly one log row', () => {
  const { db, userId } = fresh();
  const { id: subjectId } = repo.createSubject(db, userId, { name: 'Physics' });
  const { id: topicId } = repo.createTopic(db, { subjectId, name: 'Forces' });
  const { id: cardId } = repo.createCard(db, userId, {
    topicId,
    front: 'State Newton\'s second law',
    back: 'F = ma',
  });

  const first = repo.gradeCard(db, userId, cardId, 3, NOW);
  assert.ok(first);
  assert.equal(first!.state.reps, 1);
  assert.ok(first!.intervalDays >= 1);
  assert.ok(first!.state.dueAt > NOW);

  const second = repo.gradeCard(db, userId, cardId, 3, first!.state.dueAt);
  assert.equal(second!.state.reps, 2);
  assert.ok(second!.state.stability > first!.state.stability, 'recall must strengthen the card');

  const log = db.prepare('SELECT * FROM review_log WHERE card_id = ? ORDER BY reviewed_at').all(cardId) as any[];
  assert.equal(log.length, 2);
  assert.equal(log[0].stability_before, null, 'first review has no prior stability');
  assert.ok(Math.abs(log[1].retrievability - 0.9) < 0.02, 'second review happened on schedule');
});

test('grading a card that belongs to someone else is refused', () => {
  const { db, userId } = fresh();
  const other = repo.createUser(db, { displayName: 'Someone Else' });
  const { id: subjectId } = repo.createSubject(db, userId, { name: 'Physics' });
  const { id: topicId } = repo.createTopic(db, { subjectId, name: 'Forces' });
  const { id: cardId } = repo.createCard(db, userId, { topicId, front: 'q', back: 'a' });
  assert.equal(repo.gradeCard(db, other.id, cardId, 3, NOW), undefined);
});

test('a wrong answer opens a mistake entry and flags the topic for revision', () => {
  const { db, userId } = fresh();
  const { id: subjectId } = repo.createSubject(db, userId, { name: 'Maths' });
  const { id: topicId } = repo.createTopic(db, { subjectId, name: 'Vectors' });
  repo.createCard(db, userId, { topicId, front: 'q', back: 'a' });

  repo.recordAttempt(db, userId, {
    topicId,
    attemptedAt: NOW,
    correct: false,
    question: 'Resolve the force into components',
    errorCategory: 'sign error',
  });

  assert.equal(repo.countOpenMistakes(db, userId, topicId), 1);
  const cards = repo.listRevisionCards(db, userId);
  assert.equal(cards[0].flaggedByMistake, true, 'the card must be flagged for the queue');

  const mistakes = repo.listMistakes(db, userId, { openOnly: true });
  assert.equal(mistakes.length, 1);
  repo.resolveMistake(db, userId, mistakes[0].id);
  assert.equal(repo.countOpenMistakes(db, userId, topicId), 0);
  assert.equal(repo.listRevisionCards(db, userId)[0].flaggedByMistake, false);
});

test('a correct answer opens no mistake entry', () => {
  const { db, userId } = fresh();
  const { id: subjectId } = repo.createSubject(db, userId, { name: 'Maths' });
  const { id: topicId } = repo.createTopic(db, { subjectId, name: 'Vectors' });
  repo.recordAttempt(db, userId, { topicId, attemptedAt: NOW, correct: true });
  assert.equal(repo.countOpenMistakes(db, userId, topicId), 0);
});

test('note edits are versioned, never destructive', () => {
  const { db, userId } = fresh();
  const { id } = repo.createNote(db, userId, { title: 'Vectors', body: 'first draft' });
  repo.updateNote(db, userId, id, 'second draft');
  repo.updateNote(db, userId, id, 'third draft');
  const row = db.prepare('SELECT body FROM notes WHERE id = ?').get(id) as { body: string };
  assert.equal(row.body, 'third draft');
  assert.equal(repo.listNoteVersions(db, userId, id), 2, 'both prior bodies must be recoverable');
});

test('full-text search finds notes and stays in sync with edits', () => {
  const { db, userId } = fresh();
  const { id } = repo.createNote(db, userId, {
    title: 'Projectile motion',
    body: 'horizontal velocity is constant',
  });
  assert.equal(repo.searchNotes(db, userId, 'horizontal').length, 1);
  repo.updateNote(db, userId, id, 'vertical acceleration is g');
  assert.equal(repo.searchNotes(db, userId, 'horizontal').length, 0, 'stale index');
  assert.equal(repo.searchNotes(db, userId, 'acceleration').length, 1);
});

test('search never returns another user\'s notes', () => {
  const { db, userId } = fresh();
  const other = repo.createUser(db, { displayName: 'Other' });
  repo.createNote(db, other.id, { title: 'Secret', body: 'confidential material' });
  assert.deepEqual(repo.searchNotes(db, userId, 'confidential'), []);
});

test('an empty search query returns nothing instead of everything', () => {
  const { db, userId } = fresh();
  repo.createNote(db, userId, { title: 'A', body: 'b' });
  assert.deepEqual(repo.searchNotes(db, userId, '   '), []);
});

test('replaying an offline mutation is a no-op, not a duplicate', () => {
  const { db, userId } = fresh();
  const mutation = { deviceId: 'phone', seq: 1, entity: 'task', op: 'upsert' as const, payload: { title: 'x' } };
  assert.deepEqual(repo.enqueueMutation(db, userId, mutation), { accepted: true, duplicate: false });
  assert.deepEqual(repo.enqueueMutation(db, userId, mutation), { accepted: false, duplicate: true });
  assert.equal(repo.pendingMutations(db, userId), 1);
});

test('two devices can queue independently without colliding', () => {
  const { db, userId } = fresh();
  repo.enqueueMutation(db, userId, { deviceId: 'phone', seq: 1, entity: 'task', op: 'upsert', payload: {} });
  repo.enqueueMutation(db, userId, { deviceId: 'laptop', seq: 1, entity: 'task', op: 'upsert', payload: {} });
  assert.equal(repo.pendingMutations(db, userId), 2);
});

test('a failed transaction leaves no partial rows behind', () => {
  const { db, userId } = fresh();
  const before = (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
  assert.throws(() =>
    transaction(db, () => {
      repo.createTask(db, userId, { title: 'Will roll back', estimateMin: 30, priority: 2 });
      throw new Error('boom');
    }),
  );
  const after = (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
  assert.equal(after, before, 'rollback must undo the insert');
});

test('export contains the user\'s data and nothing from other users', () => {
  const { db, userId } = fresh();
  const other = repo.createUser(db, { displayName: 'Other' });
  repo.createSubject(db, other.id, { name: 'Not Mine' });

  const { id: subjectId } = repo.createSubject(db, userId, { name: 'Maths' });
  const { id: topicId } = repo.createTopic(db, { subjectId, name: 'Vectors' });
  repo.createTask(db, userId, { title: 'Problem set', estimateMin: 45, priority: 1 });
  repo.createCard(db, userId, { topicId, front: 'q', back: 'a' });
  repo.createNote(db, userId, { title: 'Notes', body: 'body' });

  const dump = repo.exportUserData(db, userId);
  assert.equal(dump.users.length, 1);
  assert.equal(dump.subjects.length, 1);
  assert.equal((dump.subjects[0] as any).name, 'Maths');
  assert.equal(dump.topics.length, 1);
  assert.equal(dump.tasks.length, 1);
  assert.equal(dump.flashcards.length, 1);
  assert.equal(dump.notes.length, 1);
  assert.ok(Object.keys(dump).length >= 20, 'export must cover every user table');
});

test('account deletion removes every row belonging to that user', () => {
  const { db, userId } = fresh();
  const { id: subjectId } = repo.createSubject(db, userId, { name: 'Maths' });
  const { id: topicId } = repo.createTopic(db, { subjectId, name: 'Vectors' });
  const { id: cardId } = repo.createCard(db, userId, { topicId, front: 'q', back: 'a' });
  repo.gradeCard(db, userId, cardId, 3, NOW);
  const task = repo.createTask(db, userId, { title: 'T', estimateMin: 30, priority: 2 });
  repo.recordEvent(db, userId, {
    id: newId('evt'), deviceId: 'laptop', startedAt: NOW, endedAt: NOW + 60_000,
    activeMs: 60_000, category: 'deep_study', provenance: 'measured', taskId: task.id,
  });
  repo.recordAttempt(db, userId, { topicId, attemptedAt: NOW, correct: false });
  const { id: noteId } = repo.createNote(db, userId, { title: 'N', body: 'b' });
  repo.updateNote(db, userId, noteId, 'b2');
  repo.enqueueMutation(db, userId, { deviceId: 'phone', seq: 1, entity: 'task', op: 'upsert', payload: {} });

  assert.ok(repo.residualRowCount(db, userId) > 0, 'precondition: data exists');
  assert.deepEqual(repo.deleteUser(db, userId), { deleted: true });
  assert.equal(repo.residualRowCount(db, userId), 0, 'deletion left rows behind');

  // Rows reachable only through joins must be gone too.
  for (const table of ['topics', 'flashcards', 'revision_states', 'review_log', 'note_versions']) {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    assert.equal(n, 0, `${table} still has rows after account deletion`);
  }
});

test('deleting one user leaves another user untouched', () => {
  const { db, userId } = fresh();
  const other = repo.createUser(db, { displayName: 'Other' });
  repo.createSubject(db, other.id, { name: 'Keep me' });
  repo.deleteUser(db, userId);
  assert.equal(repo.listSubjects(db, other.id).length, 1);
});

test('every list query is scoped to its user', () => {
  const { db, userId } = fresh();
  const other = repo.createUser(db, { displayName: 'Other' });
  const { id: subjectId } = repo.createSubject(db, other.id, { name: 'Theirs' });
  const { id: topicId } = repo.createTopic(db, { subjectId, name: 'Theirs' });
  repo.createTask(db, other.id, { title: 'Theirs', estimateMin: 10, priority: 2 });
  repo.createCard(db, other.id, { topicId, front: 'q', back: 'a' });
  repo.recordAttempt(db, other.id, { topicId, attemptedAt: NOW, correct: true });
  repo.createExam(db, other.id, { subjectId, title: 'Paper 1', startsAt: NOW + DAY_MS });
  repo.recordEvent(db, other.id, {
    id: newId('evt'), deviceId: 'd', startedAt: NOW, endedAt: NOW + 1000,
    activeMs: 1000, category: 'deep_study', provenance: 'measured',
  });

  assert.deepEqual(repo.listSubjects(db, userId), []);
  assert.deepEqual(repo.listTopics(db, userId), []);
  assert.deepEqual(repo.listTasks(db, userId), []);
  assert.deepEqual(repo.listRevisionCards(db, userId), []);
  assert.deepEqual(repo.listAttempts(db, userId), []);
  assert.deepEqual(repo.listExams(db, userId), []);
  assert.deepEqual(repo.listEvents(db, userId, 0, NOW + DAY_MS), []);
  assert.deepEqual(repo.listMistakes(db, userId), []);
  assert.equal(repo.pendingMutations(db, userId), 0);
});

test('completing and reopening a task is scoped and reversible', () => {
  const { db, userId } = fresh();
  const other = repo.createUser(db, { displayName: 'Other' });
  const task = repo.createTask(db, userId, { title: 'T', estimateMin: 30, priority: 2 });

  assert.equal(repo.completeTask(db, other.id, task.id), false, 'cross-user write must fail');
  assert.equal(repo.completeTask(db, userId, task.id, NOW), true);
  assert.equal(repo.getTask(db, userId, task.id)!.completedAt, NOW);
  assert.equal(repo.listTasks(db, userId).length, 0);
  assert.equal(repo.listTasks(db, userId, { includeCompleted: true }).length, 1);
  repo.reopenTask(db, userId, task.id);
  assert.equal(repo.getTask(db, userId, task.id)!.completedAt, undefined);
});

test('task dependencies round-trip through the database', () => {
  const { db, userId } = fresh();
  const first = repo.createTask(db, userId, { title: 'Experiment', estimateMin: 60, priority: 1 });
  const second = repo.createTask(db, userId, {
    title: 'Write-up', estimateMin: 60, priority: 2, dependsOn: [first.id],
  });
  assert.deepEqual(repo.getTask(db, userId, second.id)!.dependsOn, [first.id]);
  const listed = repo.listTasks(db, userId).find((t) => t.id === second.id);
  assert.deepEqual(listed!.dependsOn, [first.id]);
});

test('availability can be replaced for a window without touching other days', () => {
  const { db, userId } = fresh();
  const dayTwo = NOW + DAY_MS;
  repo.setAvailability(db, userId, [{ startsAt: NOW, endsAt: NOW + 3_600_000 }], { from: NOW, to: NOW + DAY_MS });
  repo.setAvailability(db, userId, [{ startsAt: dayTwo, endsAt: dayTwo + 3_600_000 }], { from: dayTwo, to: dayTwo + DAY_MS });
  assert.equal(repo.listAvailability(db, userId, NOW, NOW + 2 * DAY_MS).length, 2);

  repo.setAvailability(db, userId, [{ startsAt: NOW, endsAt: NOW + 7_200_000, fixed: true, label: 'Lesson' }], { from: NOW, to: NOW + DAY_MS });
  const blocks = repo.listAvailability(db, userId, NOW, NOW + 2 * DAY_MS);
  assert.equal(blocks.length, 2, 'day two must survive');
  assert.equal(blocks[0].fixed, true);
  assert.equal(blocks[0].label, 'Lesson');
});

test('reviews are counted only inside the requested window', () => {
  const { db, userId } = fresh();
  const { id: subjectId } = repo.createSubject(db, userId, { name: 'Maths' });
  const { id: topicId } = repo.createTopic(db, { subjectId, name: 'Vectors' });
  const { id: cardId } = repo.createCard(db, userId, { topicId, front: 'q', back: 'a' });
  repo.gradeCard(db, userId, cardId, 3, NOW);
  repo.gradeCard(db, userId, cardId, 3, NOW + 10 * DAY_MS);
  assert.equal(repo.listReviewTimestamps(db, userId, NOW - DAY_MS, NOW + DAY_MS).length, 1);
  assert.equal(repo.listReviewTimestamps(db, userId, NOW - DAY_MS, NOW + 30 * DAY_MS).length, 2);
});
