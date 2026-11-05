'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card, formatDay } from '../ui.tsx';
import { createNoteAction, deleteNoteAction, updateNoteAction } from '../actions.ts';

interface Note {
  id: string;
  title: string;
  body: string;
  topicId?: string;
  topicName?: string;
  createdAt: number;
  updatedAt: number;
  snippet?: string;
}

interface Version {
  id: string;
  body: string;
  createdAt: number;
}

interface Topic {
  id: string;
  name: string;
  subject: string;
}

export function NotesWorkspace({
  notes,
  query,
  searched,
  selected,
  history,
  topics,
}: {
  notes: Note[];
  query: string;
  searched: boolean;
  selected?: Note;
  history: Version[];
  topics: Topic[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [search, setSearch] = useState(query);

  // The URL owns the query, so a search survives a reload and can be shared.
  // Typing is debounced because every change re-runs the query server-side.
  useEffect(() => {
    if (search === query) return;
    const timer = setTimeout(() => {
      const params = new URLSearchParams();
      if (search.trim()) params.set('q', search.trim());
      startTransition(() => router.replace(params.toString() ? `/notes?${params}` : '/notes'));
    }, 180);
    return () => clearTimeout(timer);
  }, [search, query, router]);

  function open(id: string) {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    params.set('id', id);
    startTransition(() => router.replace(`/notes?${params}`));
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)] items-start">
      <div className="space-y-3">
        <div className="relative flex gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search notes"
            aria-label="Search notes"
            className="w-full rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
          />
          <NewNote onCreated={open} topics={topics} />
        </div>

        {searched && (
          <p className="text-xs dim px-1">
            {notes.length === 0
              ? `No note matches “${query}”.`
              : `${notes.length} match${notes.length === 1 ? '' : 'es'} for “${query}”`}
          </p>
        )}

        <ul className="space-y-1" style={{ opacity: pending ? 0.6 : 1 }}>
          {notes.map((n) => {
            const active = n.id === selected?.id;
            return (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => open(n.id)}
                  aria-current={active ? 'true' : undefined}
                  className="w-full rounded-lg border px-3 py-2 text-left transition-colors"
                  style={{
                    borderColor: active ? 'var(--accent)' : 'var(--border)',
                    background: active ? 'var(--surface-hover)' : 'var(--surface)',
                  }}
                >
                  <span className="block text-sm">{n.title}</span>
                  <span className="mt-0.5 block text-xs dim">
                    {n.topicName ?? 'unattached'} · {formatDay(n.updatedAt)}
                  </span>
                  {n.snippet && (
                    <span className="mt-1 block text-xs" style={{ color: 'var(--text-dim)' }}>
                      <Snippet text={n.snippet} />
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {selected ? (
        <Editor key={selected.id} note={selected} history={history} topics={topics} />
      ) : (
        <Card>
          <p className="py-8 text-center text-sm dim">
            {searched ? 'Nothing to show for this search.' : 'Select a note.'}
          </p>
        </Card>
      )}
    </div>
  );
}

/** Renders the [bracketed] runs FTS5 uses to mark matched terms. */
function Snippet({ text }: { text: string }) {
  const parts = useMemo(() => text.split(/\[([^\]]*)\]/g), [text]);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} style={{ background: 'transparent', color: 'var(--accent)' }}>
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function NewNote({
  onCreated,
  topics,
}: {
  onCreated: (id: string) => void;
  topics: Topic[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="shrink-0 rounded-lg border px-3 py-2 text-sm"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        New
      </button>
    );
  }

  return (
    <form
      ref={formRef}
      className="absolute z-10 mt-11 w-72 space-y-2 rounded-lg border p-3 shadow-lg"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      action={(formData) =>
        startTransition(async () => {
          const { id } = await createNoteAction(formData);
          setOpen(false);
          if (id) onCreated(id);
        })
      }
    >
      <input
        name="title"
        required
        autoFocus
        placeholder="Note title"
        className="w-full rounded-lg border px-3 py-2 text-sm"
        style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
      />
      <select
        name="topicId"
        defaultValue=""
        className="w-full rounded-lg border px-3 py-2 text-sm"
        style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
      >
        <option value="">No topic</option>
        {topics.map((t) => (
          <option key={t.id} value={t.id}>
            {t.subject} · {t.name}
          </option>
        ))}
      </select>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg px-3 py-1.5 text-sm"
          style={{ background: 'var(--accent)', color: 'var(--bg)' }}
        >
          {pending ? 'Creating…' : 'Create'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-sm dim">
          Cancel
        </button>
      </div>
    </form>
  );
}

type SaveState = 'clean' | 'dirty' | 'saving' | 'saved' | { error: string };

function Editor({
  note,
  history,
  topics,
}: {
  note: Note;
  history: Version[];
  topics: Topic[];
}) {
  const router = useRouter();
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [topicId, setTopicId] = useState(note.topicId ?? '');
  const [state, setState] = useState<SaveState>('clean');
  const [showHistory, setShowHistory] = useState(false);

  const dirty =
    title !== note.title || body !== note.body || topicId !== (note.topicId ?? '');

  async function save() {
    if (!dirty) return;
    setState('saving');
    const result = await updateNoteAction({
      noteId: note.id,
      title,
      body,
      topicId: topicId || null,
    });
    if (!result.ok) {
      setState({ error: result.reason ?? 'could not save' });
      return;
    }
    setState('saved');
    router.refresh();
  }

  async function remove() {
    await deleteNoteAction(note.id);
    router.replace('/notes');
  }

  return (
    <Card
      title={note.title}
      action={
        <span className="text-xs dim">
          created {formatDay(note.createdAt)} · edited {formatDay(note.updatedAt)}
        </span>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs dim">Title</span>
            <input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setState('dirty');
              }}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
            />
          </label>
          <label className="block">
            <span className="text-xs dim">Topic</span>
            <select
              value={topicId}
              onChange={(e) => {
                setTopicId(e.target.value);
                setState('dirty');
              }}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
            >
              <option value="">No topic</option>
              {topics.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.subject} · {t.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="block">
          <span className="text-xs dim">Body</span>
          <textarea
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              setState('dirty');
            }}
            onBlur={save}
            rows={14}
            placeholder="What you worked out, in your own words."
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm leading-relaxed"
            style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
          />
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={!dirty || state === 'saving'}
            className="rounded-lg px-3 py-1.5 text-sm disabled:opacity-40"
            style={{ background: 'var(--accent)', color: 'var(--bg)' }}
          >
            {state === 'saving' ? 'Saving…' : 'Save'}
          </button>
          <span className="text-xs dim">
            {typeof state === 'object'
              ? state.error
              : state === 'saving'
                ? 'Saving…'
                : state === 'saved' && !dirty
                  ? 'Saved. The replaced version is kept.'
                  : dirty
                    ? 'Unsaved changes'
                    : 'Up to date'}
          </span>
          <button
            type="button"
            onClick={remove}
            className="ml-auto text-xs"
            style={{ color: 'var(--danger, #e5484d)' }}
          >
            Delete note
          </button>
        </div>

        <div className="border-t pt-3" style={{ borderColor: 'var(--border)' }}>
          {history.length === 0 ? (
            <p className="text-xs dim">No earlier version — this note has not been edited yet.</p>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setShowHistory((v) => !v)}
                className="text-xs"
                style={{ color: 'var(--accent)' }}
                aria-expanded={showHistory}
              >
                {showHistory ? 'Hide' : 'Show'} {history.length} earlier version
                {history.length === 1 ? '' : 's'}
              </button>
              {showHistory && (
                <ul className="mt-2 space-y-2">
                  {history.map((v) => (
                    <li
                      key={v.id}
                      className="rounded-lg border p-2"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <p className="text-xs dim">replaced {formatDay(v.createdAt)}</p>
                      <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed">
                        {v.body || <span className="dim">(was empty)</span>}
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setBody(v.body);
                          setState('dirty');
                        }}
                        className="mt-1 text-xs"
                        style={{ color: 'var(--accent)' }}
                      >
                        Restore this text
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
