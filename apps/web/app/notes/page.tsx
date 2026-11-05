import { loadNotes } from '../../lib/queries.ts';
import { Card, Empty } from '../ui.tsx';
import { NotesWorkspace } from './workspace.tsx';

export const dynamic = 'force-dynamic';

export default async function NotesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; id?: string }>;
}) {
  const { q, id } = await searchParams;
  const d = loadNotes(q, id);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Notes</h1>
        <p className="text-sm dim mt-1">
          {d.total === 0
            ? 'Write what you worked out, attached to the topic it belongs to.'
            : `${d.total} note${d.total === 1 ? '' : 's'}. Search runs over titles and bodies; every edit keeps the version it replaced.`}
        </p>
      </header>

      {d.total === 0 && !d.searched ? (
        <Card>
          <Empty
            title="No notes yet"
            hint="A note attached to a topic shows up beside that topic's mastery evidence."
          />
        </Card>
      ) : null}

      <NotesWorkspace
        notes={d.notes}
        query={d.query}
        searched={d.searched}
        selected={d.selected}
        history={d.history}
        topics={d.topics}
      />
    </div>
  );
}
