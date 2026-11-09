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
  assert.deepEqual(rows.map((r) => r.id), [
    '001_core',
    '002_fts_notes',
    '003_user_fsrs_params',
    '004_stability_scale',
  ]);
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
  repo.updateNote(db, userId, id, { body: 'second draft' });
  repo.updateNote(db, userId, id, { body: 'third draft' });
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
  repo.updateNote(db, userId, id, { body: 'vertical acceleration is g' });
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

test('a search box cannot be made to throw by what a student types', () => {
  const { db, userId } = fresh();
  repo.createNote(db, userId, {
    title: 'Vectors in C++',
    body: 'dot product AND cross product, NEAR the origin (3D)',
  });
  // Each of these is a syntax error, an unterminated string or a bogus column
  // reference if handed to FTS5 MATCH as typed.
  for (const query of ['C++', 'what?', '"unclosed', 'foo:', 'AND', '*', 'NEAR', '-x', 'a OR', '((']) {
    assert.doesNotThrow(() => repo.searchNotes(db, userId, query), `query ${query} threw`);
  }
});

test('operator words are searched as words, not parsed as operators', () => {
  const { db, userId } = fresh();
  repo.createNote(db, userId, { title: 'Logic', body: 'the AND gate and the NEAR miss' });
  repo.createNote(db, userId, { title: 'Optics', body: 'refraction at a boundary' });
  assert.equal(repo.searchNotes(db, userId, 'AND gate').length, 1);
  assert.equal(repo.searchNotes(db, userId, 'NEAR miss').length, 1);
  assert.equal(repo.searchNotes(db, userId, 'NEAR boundary').length, 0, 'must not match across notes');
});

test('punctuation-only input is no query, not a match-everything query', () => {
  const { db, userId } = fresh();
  repo.createNote(db, userId, { title: 'A', body: 'b' });
  for (const query of ['', '   ', '!!!', '...', '-']) {
    assert.deepEqual(repo.searchNotes(db, userId, query), [], `query ${JSON.stringify(query)}`);
  }
});

test('search narrows as the last word is typed', () => {
  const { db, userId } = fresh();
  repo.createNote(db, userId, { title: 'Momentum', body: 'conservation of momentum' });
  assert.equal(repo.searchNotes(db, userId, 'cons').length, 1, 'prefix of the last token');
  assert.equal(repo.searchNotes(db, userId, 'cons momentum').length, 0, 'earlier tokens are exact');
  assert.equal(repo.searchNotes(db, userId, 'c').length, 0, 'one character is not a wildcard');
});

test('retitling a note does not manufacture a version', () => {
  const { db, userId } = fresh();
  const { id } = repo.createNote(db, userId, { title: 'Draft', body: 'body text' });
  repo.updateNote(db, userId, id, { title: 'Projectiles' });
  assert.equal(repo.listNoteVersions(db, userId, id), 0, 'no body change, no snapshot');
  assert.equal(repo.getNote(db, userId, id)?.title, 'Projectiles');
  assert.equal(repo.searchNotes(db, userId, 'Projectiles').length, 1, 'index follows the title');
});

test('a note cannot be attached to another user\'s topic', () => {
  const { db, userId } = fresh();
  const other = repo.createUser(db, { displayName: 'Other' });
  const subject = repo.createSubject(db, other.id, { name: 'Theirs' });
  const topic = repo.createTopic(db, { subjectId: subject.id, name: 'Their topic' });

  const { id } = repo.createNote(db, userId, { title: 'Mine', body: 'x', topicId: topic.id });
  assert.equal(repo.getNote(db, userId, id)?.topicId, undefined, 'topic must be dropped');
  assert.equal(repo.updateNote(db, userId, id, { topicId: topic.id }), false, 'and refused on edit');
});

test('a note carries its topic name for display', () => {
  const { db, userId } = fresh();
  const subject = repo.createSubject(db, userId, { name: 'Physics HL' });
  const topic = repo.createTopic(db, { subjectId: subject.id, name: 'Kinematics' });
  const { id } = repo.createNote(db, userId, { title: 'N', body: 'x', topicId: topic.id });
  assert.equal(repo.getNote(db, userId, id)?.topicName, 'Kinematics');
  assert.equal(repo.listNotes(db, userId)[0].topicName, 'Kinematics');
});

test('deleting a note clears its versions and its search index', () => {
  const { db, userId } = fresh();
  const { id } = repo.createNote(db, userId, { title: 'Temporary', body: 'first' });
  repo.updateNote(db, userId, id, { body: 'second' });
  assert.equal(repo.searchNotes(db, userId, 'second').length, 1);

  assert.equal(repo.deleteNote(db, userId, id), true);
  assert.deepEqual(repo.searchNotes(db, userId, 'second'), [], 'index must not outlive the note');
  const versions = db.prepare('SELECT COUNT(*) AS n FROM note_versions').get() as { n: number };
  assert.equal(versions.n, 0);
  assert.equal(repo.deleteNote(db, userId, id), false, 'deleting twice is not a success');
});

test('another user cannot read, edit or delete your notes', () => {
  const { db, userId } = fresh();
  const other = repo.createUser(db, { displayName: 'Other' });
  const { id } = repo.createNote(db, userId, { title: 'Mine', body: 'private' });

  assert.equal(repo.getNote(db, other.id, id), undefined);
  assert.deepEqual(repo.listNotes(db, other.id), []);
  assert.equal(repo.updateNote(db, other.id, id, { body: 'tampered' }), false);
  assert.equal(repo.deleteNote(db, other.id, id), false);
  assert.deepEqual(repo.listNoteHistory(db, other.id, id), []);
  assert.equal(repo.getNote(db, userId, id)?.body, 'private', 'untouched');
});

test('note history returns superseded bodies, newest first', () => {
  const { db, userId } = fresh();
  const { id } = repo.createNote(db, userId, { title: 'N', body: 'v1' });
  repo.updateNote(db, userId, id, { body: 'v2' });
  repo.updateNote(db, userId, id, { body: 'v3' });
  const history = repo.listNoteHistory(db, userId, id);
  assert.deepEqual(history.map((h) => h.body), ['v2', 'v1']);
  assert.equal(repo.getNote(db, userId, id)?.body, 'v3', 'current body is not in history');
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
  repo.updateNote(db, userId, noteId, { body: 'b2' });
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

test('topic links round-trip and are scoped to their owner', () => {
  const { db, userId } = fresh();
  const { id: subjectId } = repo.createSubject(db, userId, { name: 'Maths' });
  const a = repo.createTopic(db, { subjectId, name: 'Differentiation' });
  const b = repo.createTopic(db, { subjectId, name: 'Integration' });

  assert.deepEqual(
    repo.createTopicLink(db, userId, { fromTopicId: a.id, toTopicId: b.id, kind: 'prerequisite' }),
    { created: true },
  );
  const links = repo.listTopicLinks(db, userId);
  assert.deepEqual(links, [{ fromTopicId: a.id, toTopicId: b.id, kind: 'prerequisite' }]);

  const other = repo.createUser(db, { displayName: 'Other' });
  assert.deepEqual(repo.listTopicLinks(db, other.id), [], 'links must not leak across users');
});

test('a duplicate topic link is a no-op rather than an error', () => {
  const { db, userId } = fresh();
  const { id: subjectId } = repo.createSubject(db, userId, { name: 'Maths' });
  const a = repo.createTopic(db, { subjectId, name: 'A' });
  const b = repo.createTopic(db, { subjectId, name: 'B' });
  const link = { fromTopicId: a.id, toTopicId: b.id, kind: 'prerequisite' as const };
  assert.equal(repo.createTopicLink(db, userId, link).created, true);
  assert.equal(repo.createTopicLink(db, userId, link).created, false);
  assert.equal(repo.listTopicLinks(db, userId).length, 1);
});

test('a topic cannot be made its own prerequisite', () => {
  const { db, userId } = fresh();
  const { id: subjectId } = repo.createSubject(db, userId, { name: 'Maths' });
  const a = repo.createTopic(db, { subjectId, name: 'A' });
  const result = repo.createTopicLink(db, userId, {
    fromTopicId: a.id,
    toTopicId: a.id,
    kind: 'prerequisite',
  });
  assert.equal(result.created, false);
  assert.match(result.reason!, /own prerequisite/);
});

test('linking across accounts is refused', () => {
  const { db, userId } = fresh();
  const other = repo.createUser(db, { displayName: 'Other' });
  const mine = repo.createTopic(db, {
    subjectId: repo.createSubject(db, userId, { name: 'Mine' }).id,
    name: 'Mine',
  });
  const theirs = repo.createTopic(db, {
    subjectId: repo.createSubject(db, other.id, { name: 'Theirs' }).id,
    name: 'Theirs',
  });
  const result = repo.createTopicLink(db, userId, {
    fromTopicId: mine.id,
    toTopicId: theirs.id,
    kind: 'prerequisite',
  });
  assert.equal(result.created, false);
  assert.match(result.reason!, /belong to this user/);
  assert.deepEqual(repo.listTopicLinks(db, userId), []);
});

test('deleting a topic removes its links, and account deletion clears them', () => {
  const { db, userId } = fresh();
  const { id: subjectId } = repo.createSubject(db, userId, { name: 'Maths' });
  const a = repo.createTopic(db, { subjectId, name: 'A' });
  const b = repo.createTopic(db, { subjectId, name: 'B' });
  repo.createTopicLink(db, userId, { fromTopicId: a.id, toTopicId: b.id, kind: 'prerequisite' });

  db.prepare('DELETE FROM topics WHERE id = ?').run(a.id);
  assert.deepEqual(repo.listTopicLinks(db, userId), [], 'links must cascade with the topic');

  const c = repo.createTopic(db, { subjectId, name: 'C' });
  repo.createTopicLink(db, userId, { fromTopicId: b.id, toTopicId: c.id, kind: 'related' });
  assert.ok(repo.exportUserData(db, userId).topic_links.length === 1, 'export must include links');

  repo.deleteUser(db, userId);
  const left = db.prepare('SELECT COUNT(*) AS n FROM topic_links').get() as { n: number };
  assert.equal(left.n, 0, 'account deletion left topic links behind');
});

test('a circular prerequisite chain is refused at the database boundary', () => {
  const { db, userId } = fresh();
  const { id: subjectId } = repo.createSubject(db, userId, { name: 'Maths' });
  const a = repo.createTopic(db, { subjectId, name: 'A' });
  const b = repo.createTopic(db, { subjectId, name: 'B' });
  const c = repo.createTopic(db, { subjectId, name: 'C' });

  repo.createTopicLink(db, userId, { fromTopicId: a.id, toTopicId: b.id, kind: 'prerequisite' });
  repo.createTopicLink(db, userId, { fromTopicId: b.id, toTopicId: c.id, kind: 'prerequisite' });

  const direct = repo.createTopicLink(db, userId, {
    fromTopicId: b.id, toTopicId: a.id, kind: 'prerequisite',
  });
  assert.equal(direct.created, false);
  assert.match(direct.reason!, /circular/);

  const transitive = repo.createTopicLink(db, userId, {
    fromTopicId: c.id, toTopicId: a.id, kind: 'prerequisite',
  });
  assert.equal(transitive.created, false, 'a long way round is still a loop');

  assert.equal(repo.listTopicLinks(db, userId).length, 2, 'nothing was written');
});

test('a related link may run in both directions without being a cycle', () => {
  const { db, userId } = fresh();
  const { id: subjectId } = repo.createSubject(db, userId, { name: 'Maths' });
  const a = repo.createTopic(db, { subjectId, name: 'A' });
  const b = repo.createTopic(db, { subjectId, name: 'B' });
  assert.equal(
    repo.createTopicLink(db, userId, { fromTopicId: a.id, toTopicId: b.id, kind: 'related' }).created,
    true,
  );
  assert.equal(
    repo.createTopicLink(db, userId, { fromTopicId: b.id, toTopicId: a.id, kind: 'related' }).created,
    true,
  );
});

test('a forward shortcut alongside a chain is allowed', () => {
  const { db, userId } = fresh();
  const { id: subjectId } = repo.createSubject(db, userId, { name: 'Maths' });
  const a = repo.createTopic(db, { subjectId, name: 'A' });
  const b = repo.createTopic(db, { subjectId, name: 'B' });
  const c = repo.createTopic(db, { subjectId, name: 'C' });
  repo.createTopicLink(db, userId, { fromTopicId: a.id, toTopicId: b.id, kind: 'prerequisite' });
  repo.createTopicLink(db, userId, { fromTopicId: b.id, toTopicId: c.id, kind: 'prerequisite' });
  assert.equal(
    repo.createTopicLink(db, userId, { fromTopicId: a.id, toTopicId: c.id, kind: 'prerequisite' })
      .created,
    true,
    'a→c runs with the grain, not against it',
  );
});

test('a cycle check on one user ignores another user\'s links', () => {
  const { db, userId } = fresh();
  const other = repo.createUser(db, { displayName: 'Other' });
  const mySubject = repo.createSubject(db, userId, { name: 'Mine' }).id;
  const a = repo.createTopic(db, { subjectId: mySubject, name: 'A' });
  const b = repo.createTopic(db, { subjectId: mySubject, name: 'B' });

  const theirSubject = repo.createSubject(db, other.id, { name: 'Theirs' }).id;
  const x = repo.createTopic(db, { subjectId: theirSubject, name: 'X' });
  const y = repo.createTopic(db, { subjectId: theirSubject, name: 'Y' });
  repo.createTopicLink(db, other.id, { fromTopicId: x.id, toTopicId: y.id, kind: 'prerequisite' });

  assert.equal(
    repo.createTopicLink(db, userId, { fromTopicId: a.id, toTopicId: b.id, kind: 'prerequisite' })
      .created,
    true,
  );
});

test('deleting a link frees the reverse direction', () => {
  const { db, userId } = fresh();
  const { id: subjectId } = repo.createSubject(db, userId, { name: 'Maths' });
  const a = repo.createTopic(db, { subjectId, name: 'A' });
  const b = repo.createTopic(db, { subjectId, name: 'B' });
  const link = { fromTopicId: a.id, toTopicId: b.id, kind: 'prerequisite' as const };

  repo.createTopicLink(db, userId, link);
  assert.equal(
    repo.createTopicLink(db, userId, { fromTopicId: b.id, toTopicId: a.id, kind: 'prerequisite' })
      .created,
    false,
  );

  assert.equal(repo.deleteTopicLink(db, userId, link), true);
  assert.equal(
    repo.createTopicLink(db, userId, { fromTopicId: b.id, toTopicId: a.id, kind: 'prerequisite' })
      .created,
    true,
    'with the original gone, the reverse is legal',
  );
});

test('deleting a link that does not exist reports false', () => {
  const { db, userId } = fresh();
  const { id: subjectId } = repo.createSubject(db, userId, { name: 'Maths' });
  const a = repo.createTopic(db, { subjectId, name: 'A' });
  const b = repo.createTopic(db, { subjectId, name: 'B' });
  assert.equal(
    repo.deleteTopicLink(db, userId, {
      fromTopicId: a.id, toTopicId: b.id, kind: 'prerequisite',
    }),
    false,
  );
});

test('another user cannot delete your links', () => {
  const { db, userId } = fresh();
  const other = repo.createUser(db, { displayName: 'Other' });
  const { id: subjectId } = repo.createSubject(db, userId, { name: 'Maths' });
  const a = repo.createTopic(db, { subjectId, name: 'A' });
  const b = repo.createTopic(db, { subjectId, name: 'B' });
  const link = { fromTopicId: a.id, toTopicId: b.id, kind: 'prerequisite' as const };
  repo.createTopicLink(db, userId, link);

  assert.equal(repo.deleteTopicLink(db, other.id, link), false);
  assert.equal(repo.listTopicLinks(db, userId).length, 1, 'the link must survive');
});

test('a user with no stored fit gets the published model', () => {
  const { db, userId } = fresh();
  assert.equal(repo.getUserFsrsParams(db, userId).stabilityScale, 1);
  assert.equal(repo.getStoredFit(db, userId), undefined);
});

test('a stored fit keeps the evidence that justified it', () => {
  const { db, userId } = fresh();
  repo.setStabilityScale(db, userId, {
    scale: 0.62,
    fittedFromReviews: 412,
    interval: [0.48, 0.81],
  });
  assert.equal(repo.getUserFsrsParams(db, userId).stabilityScale, 0.62);
  const stored = repo.getStoredFit(db, userId);
  assert.equal(stored?.fittedFromReviews, 412);
  assert.deepEqual(stored?.interval, [0.48, 0.81]);
});

test('refitting replaces the stored correction rather than adding a second', () => {
  const { db, userId } = fresh();
  repo.setStabilityScale(db, userId, { scale: 0.62, fittedFromReviews: 412 });
  repo.setStabilityScale(db, userId, { scale: 0.71, fittedFromReviews: 530 });
  const rows = db.prepare('SELECT COUNT(*) AS n FROM revision_params').get() as { n: number };
  assert.equal(rows.n, 1);
  assert.equal(repo.getStoredFit(db, userId)?.scale, 0.71);
});

test('clearing a fit returns the user to the published model', () => {
  const { db, userId } = fresh();
  repo.setStabilityScale(db, userId, { scale: 0.62, fittedFromReviews: 412, interval: [0.4, 0.8] });
  repo.setStabilityScale(db, userId, undefined);
  assert.equal(repo.getUserFsrsParams(db, userId).stabilityScale, 1);
  assert.equal(repo.getStoredFit(db, userId), undefined, 'the stale evidence must go too');
});

test('one user\'s fit never reaches another', () => {
  const { db, userId } = fresh();
  const other = repo.createUser(db, { displayName: 'Other' });
  repo.setStabilityScale(db, userId, { scale: 0.5, fittedFromReviews: 300 });
  assert.equal(repo.getUserFsrsParams(db, other.id).stabilityScale, 1);
  assert.equal(repo.getStoredFit(db, other.id), undefined);
});

test('the review history reads back in order and only your own', () => {
  const { db, userId } = fresh();
  const subject = repo.createSubject(db, userId, { name: 'Physics HL' });
  const topic = repo.createTopic(db, { subjectId: subject.id, name: 'Kinematics' });
  const card = repo.createCard(db, userId, { topicId: topic.id, front: 'q', back: 'a' });
  repo.gradeCard(db, userId, card.id, 3, NOW);
  repo.gradeCard(db, userId, card.id, 1, NOW + 5 * DAY_MS);

  const history = repo.listReviewHistory(db, userId);
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((h) => h.grade), [3, 1]);
  assert.ok(history[0].reviewedAt < history[1].reviewedAt);
  assert.equal(history[0].cardId, card.id);

  const other = repo.createUser(db, { displayName: 'Other' });
  assert.deepEqual(repo.listReviewHistory(db, other.id), []);
});
