import { db, currentUserId } from '../../lib/db.ts';
import * as repo from '@studyos/db';
import { FocusTimer } from './timer.tsx';

export const dynamic = 'force-dynamic';

export default function FocusPage() {
  const conn = db();
  const userId = currentUserId();
  const subjects = repo.listSubjects(conn, userId).map((s) => ({ id: s.id, name: s.name }));
  const tasks = repo
    .listTasks(conn, userId)
    .map((t) => ({ id: t.id, title: t.title, subjectId: t.subjectId }));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Focus</h1>
        <p className="text-sm dim mt-1">
          Elapsed and active time are tracked separately. Pauses reduce active time only.
        </p>
      </header>
      <FocusTimer subjects={subjects} tasks={tasks} />
    </div>
  );
}
