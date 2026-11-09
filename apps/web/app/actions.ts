'use server';

import { revalidatePath } from 'next/cache';
import * as repo from '@studyos/db';
import { newId } from '@studyos/db';
import { fitStabilityScale, type ReviewGrade } from '@studyos/core';
import { db, currentUserId } from '../lib/db.ts';

export async function gradeCardAction(cardId: string, grade: number) {
  const g = Math.min(Math.max(Math.round(grade), 1), 4) as ReviewGrade;
  const result = repo.gradeCard(db(), currentUserId(), cardId, g);
  revalidatePath('/revision');
  revalidatePath('/');
  return result ? { intervalDays: result.intervalDays } : { error: 'card not found' };
}

export async function completeTaskAction(taskId: string) {
  repo.completeTask(db(), currentUserId(), taskId);
  revalidatePath('/');
  revalidatePath('/planner');
}

export async function reopenTaskAction(taskId: string) {
  repo.reopenTask(db(), currentUserId(), taskId);
  revalidatePath('/');
  revalidatePath('/planner');
}

export async function createTaskAction(formData: FormData) {
  const title = String(formData.get('title') ?? '').trim();
  if (!title) return;
  const estimate = Number(formData.get('estimateMin') ?? 30);
  const subjectId = String(formData.get('subjectId') ?? '') || undefined;
  const dueDate = String(formData.get('dueAt') ?? '');
  repo.createTask(db(), currentUserId(), {
    title,
    estimateMin: Number.isFinite(estimate) && estimate > 0 ? estimate : 30,
    priority: 2,
    subjectId,
    dueAt: dueDate ? new Date(`${dueDate}T23:59:59`).getTime() : undefined,
  });
  revalidatePath('/');
  revalidatePath('/planner');
}

/**
 * Save a finished focus session as a recorded activity event. Sessions logged
 * through the UI are 'confirmed' — a human stated they happened — which is a
 * different and higher-trust provenance than an OS-measured event.
 */
export async function saveFocusSessionAction(input: {
  startedAt: number;
  endedAt: number;
  activeMs: number;
  category: string;
  subjectId?: string;
  taskId?: string;
  mode: string;
  goal?: string;
  reflection?: string;
}) {
  const conn = db();
  const userId = currentUserId();
  if (input.endedAt <= input.startedAt) return { error: 'session had no duration' };

  const eventId = newId('evt');
  repo.recordEvent(conn, userId, {
    id: eventId,
    deviceId: 'web',
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    activeMs: Math.min(input.activeMs, input.endedAt - input.startedAt),
    category: input.category as never,
    provenance: 'confirmed',
    subjectId: input.subjectId,
    taskId: input.taskId,
    note: input.goal,
  });
  conn
    .prepare(
      `INSERT INTO focus_sessions (id, user_id, event_id, mode, goal, reflection, started_at, ended_at, interrupted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      newId('fcs'),
      userId,
      eventId,
      input.mode,
      input.goal ?? null,
      input.reflection ?? null,
      input.startedAt,
      input.endedAt,
    );
  revalidatePath('/');
  revalidatePath('/analytics');
  return { ok: true, minutes: Math.round((input.endedAt - input.startedAt) / 60000) };
}

export async function recordAttemptAction(
  topicId: string,
  correct: boolean,
  errorCategory?: string,
) {
  repo.recordAttempt(db(), currentUserId(), {
    topicId,
    attemptedAt: Date.now(),
    correct,
    errorCategory,
  });
  revalidatePath('/subjects');
  revalidatePath('/');
}

export async function resolveMistakeAction(mistakeId: string) {
  repo.resolveMistake(db(), currentUserId(), mistakeId);
  revalidatePath('/revision');
  revalidatePath('/subjects');
}

/** Full data export. The privacy promise has to be executable, not a policy. */
export async function exportDataAction() {
  const dump = repo.exportUserData(db(), currentUserId());
  return JSON.stringify(dump, null, 2);
}

/**
 * Knowledge-graph link editing.
 *
 * Validation (ownership, self-links, circular chains) lives in the repository
 * rather than here, so it holds for every caller. These actions just report
 * the refusal back to the UI instead of swallowing it.
 */
export async function linkTopicsAction(input: {
  fromTopicId: string;
  toTopicId: string;
  kind: 'prerequisite' | 'related';
}): Promise<{ ok: boolean; reason?: string }> {
  const result = repo.createTopicLink(db(), currentUserId(), input);
  if (!result.created) {
    return { ok: false, reason: result.reason ?? 'that link already exists' };
  }
  revalidatePath('/graph');
  revalidatePath('/subjects');
  return { ok: true };
}

export async function unlinkTopicsAction(input: {
  fromTopicId: string;
  toTopicId: string;
  kind: 'prerequisite' | 'related';
}): Promise<{ ok: boolean; reason?: string }> {
  const removed = repo.deleteTopicLink(db(), currentUserId(), input);
  if (!removed) return { ok: false, reason: 'that link no longer exists' };
  revalidatePath('/graph');
  revalidatePath('/subjects');
  return { ok: true };
}

export async function createNoteAction(formData: FormData): Promise<{ id?: string }> {
  const title = String(formData.get('title') ?? '').trim();
  if (!title) return {};
  const topicId = String(formData.get('topicId') ?? '') || undefined;
  const { id } = repo.createNote(db(), currentUserId(), { title, topicId, body: '' });
  revalidatePath('/notes');
  return { id };
}

export async function updateNoteAction(input: {
  noteId: string;
  body?: string;
  title?: string;
  topicId?: string | null;
}): Promise<{ ok: boolean; reason?: string }> {
  const { noteId, ...patch } = input;
  if (patch.title !== undefined && !patch.title.trim()) {
    return { ok: false, reason: 'a note needs a title' };
  }
  const ok = repo.updateNote(db(), currentUserId(), noteId, patch);
  if (!ok) return { ok: false, reason: 'that note could not be saved' };
  revalidatePath('/notes');
  return { ok: true };
}

export async function deleteNoteAction(noteId: string): Promise<{ ok: boolean }> {
  const ok = repo.deleteNote(db(), currentUserId(), noteId);
  revalidatePath('/notes');
  return { ok };
}

/**
 * Adopt the fitted correction. Refuses anything the fitter itself refused,
 * so the only way to end up with a stored scale is through evidence that
 * cleared the thresholds.
 */
export async function applyFitAction(): Promise<{ ok: boolean; reason?: string }> {
  const conn = db();
  const userId = currentUserId();
  const fit = fitStabilityScale(repo.listReviewHistory(conn, userId));
  if (!fit.fitted) return { ok: false, reason: fit.reason ?? 'there is nothing to apply' };

  repo.setStabilityScale(conn, userId, {
    scale: fit.scale,
    fittedFromReviews: fit.scored,
    interval: fit.interval,
  });
  // A correction changes every modelled recall and every future interval.
  for (const path of ['/', '/revision', '/subjects', '/graph', '/report', '/calibration']) {
    revalidatePath(path);
  }
  return { ok: true };
}

export async function clearFitAction(): Promise<{ ok: boolean }> {
  repo.setStabilityScale(db(), currentUserId(), undefined);
  for (const path of ['/', '/revision', '/subjects', '/graph', '/report', '/calibration']) {
    revalidatePath(path);
  }
  return { ok: true };
}
