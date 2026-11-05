'use client';

import { useState } from 'react';
import { gradeCardAction } from '../actions.ts';

type QueuedCard = {
  id: string;
  subjectId: string;
  topicId: string;
  predictedRetention?: number;
  reason: string;
  detail?: { front: string; back: string; topicName: string; subjectName: string };
};

const GRADES = [
  { grade: 1, label: 'Again', hint: 'I could not recall it', tone: 'var(--color-danger)' },
  { grade: 2, label: 'Hard', hint: 'Recalled with difficulty', tone: 'var(--color-caution)' },
  { grade: 3, label: 'Good', hint: 'Recalled correctly', tone: 'var(--color-accent)' },
  { grade: 4, label: 'Easy', hint: 'Instant recall', tone: 'var(--color-positive)' },
] as const;

export function Reviewer({ cards }: { cards: QueuedCard[] }) {
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<Array<{ label: string; intervalDays: number }>>([]);

  const card = cards[index];

  if (!card) {
    return (
      <div className="card p-8 text-center">
        <p className="text-lg font-medium">Queue cleared</p>
        <p className="mt-1 text-sm dim">
          {log.length > 0
            ? `${log.length} card${log.length === 1 ? '' : 's'} reviewed. Next due dates come from FSRS, not a fixed interval.`
            : 'Nothing is due right now.'}
        </p>
        {log.length > 0 && (
          <ul className="mt-4 inline-flex flex-col gap-1 text-left text-xs dim">
            {log.slice(-6).map((entry, i) => (
              <li key={i}>
                {entry.label} → next in {entry.intervalDays}d
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  async function grade(g: number, label: string) {
    setBusy(true);
    const result = await gradeCardAction(card.id, g);
    setBusy(false);
    if ('intervalDays' in result && result.intervalDays !== undefined) {
      setLog((l) => [...l, { label, intervalDays: result.intervalDays! }]);
    }
    setRevealed(false);
    setIndex((i) => i + 1);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-xs dim">
        <span>
          Card {index + 1} of {cards.length}
        </span>
        <span>{card.detail?.subjectName ?? card.subjectId}</span>
      </div>

      <div className="card p-8">
        <div className="text-xs dim uppercase tracking-wide">
          {card.detail?.topicName ?? card.topicId}
        </div>
        <p className="mt-3 text-xl leading-snug">{card.detail?.front ?? '(card text missing)'}</p>

        {revealed ? (
          <div
            className="mt-6 border-t pt-5 text-base leading-relaxed"
            style={{ borderColor: 'var(--border)' }}
          >
            {card.detail?.back}
          </div>
        ) : (
          <button
            onClick={() => setRevealed(true)}
            className="mt-6 rounded-lg px-5 py-2.5 text-sm font-medium"
            style={{ background: 'var(--surface-hover)' }}
          >
            Show answer
          </button>
        )}

        {revealed && (
          <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {GRADES.map((g) => (
              <button
                key={g.grade}
                disabled={busy}
                onClick={() => grade(g.grade, g.label)}
                className="rounded-lg border px-3 py-2.5 text-left disabled:opacity-50"
                style={{ borderColor: g.tone }}
              >
                <div className="text-sm font-medium" style={{ color: g.tone }}>
                  {g.label}
                </div>
                <div className="text-[11px] dim leading-tight mt-0.5">{g.hint}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      <p className="text-xs dim">Why this card now: {card.reason}.</p>
    </div>
  );
}
