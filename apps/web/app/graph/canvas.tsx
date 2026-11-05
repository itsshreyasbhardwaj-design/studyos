'use client';

import { useMemo, useState, useTransition } from 'react';
import type { GraphEdge, GraphNode, MasteryState, TopicLink } from '@studyos/core';
import { MASTERY_LABELS, SOLID_STRENGTH, linkCandidates } from '@studyos/core';
import { linkTopicsAction, unlinkTopicsAction } from '../actions.ts';

const NODE_W = 168;
const NODE_H = 50;

/**
 * Mastery palette. Deliberately the same hues the rest of the app uses for
 * mastery, so a colour means the same thing on every screen.
 */
const TONE: Record<MasteryState, string> = {
  not_started: 'var(--color-ink-500)',
  learning: 'var(--color-caution)',
  practising: 'var(--color-accent)',
  needs_revision: 'var(--color-danger)',
  strong: 'var(--color-positive)',
  mastered: 'var(--color-positive)',
};

const STATES: MasteryState[] = [
  'not_started',
  'learning',
  'practising',
  'needs_revision',
  'strong',
  'mastered',
];

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  cycles: string[][];
  width: number;
  height: number;
}

export function GraphCanvas({
  graph,
  details,
  focusTopicId,
}: {
  graph: GraphData;
  details: Record<string, { nextStep: string; reasons: string[] }>;
  focusTopicId?: string;
}) {
  const [selected, setSelected] = useState<string | null>(focusTopicId ?? null);
  const [query, setQuery] = useState('');
  const [hidden, setHidden] = useState<Set<MasteryState>>(new Set());
  const [zoom, setZoom] = useState(1);

  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const byId = useMemo(
    () => new Map(graph.nodes.map((n) => [n.topicId, n])),
    [graph.nodes],
  );

  // The drawn edges are the links, so the editor needs no extra round trip.
  const links = useMemo<TopicLink[]>(
    () =>
      graph.edges.map((e) => ({ fromTopicId: e.from, toTopicId: e.to, kind: e.kind })),
    [graph.edges],
  );

  function runLinkChange(fn: () => Promise<{ ok: boolean; reason?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) setError(result.reason ?? 'that change was refused');
    });
  }

  function removeLink(otherId: string, relation: Relation) {
    const link =
      relation === 'related'
        ? links.find(
            (l) =>
              l.kind === 'related' &&
              ((l.fromTopicId === selected && l.toTopicId === otherId) ||
                (l.fromTopicId === otherId && l.toTopicId === selected)),
          )
        : relation === 'requires'
          ? { fromTopicId: otherId, toTopicId: selected!, kind: 'prerequisite' as const }
          : { fromTopicId: selected!, toTopicId: otherId, kind: 'prerequisite' as const };
    if (!link) return;
    runLinkChange(() => unlinkTopicsAction(link));
  }

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return new Set(
      graph.nodes
        .filter(
          (n) =>
            n.name.toLowerCase().includes(q) ||
            (n.subjectName ?? '').toLowerCase().includes(q),
        )
        .map((n) => n.topicId),
    );
  }, [query, graph.nodes]);

  /** Ids one hop from the selection — what stays lit when something is selected. */
  const focusSet = useMemo(() => {
    if (!selected) return null;
    const node = byId.get(selected);
    if (!node) return null;
    return new Set([
      selected,
      ...node.prerequisiteIds,
      ...node.dependentIds,
      ...node.relatedIds,
    ]);
  }, [selected, byId]);

  function visible(node: GraphNode): boolean {
    return !hidden.has(node.state);
  }

  /** Dimmed nodes stay on the canvas so structure is never lost, just quieted. */
  function dimmed(node: GraphNode): boolean {
    if (!visible(node)) return true;
    if (matches && !matches.has(node.topicId)) return true;
    if (focusSet && !focusSet.has(node.topicId)) return true;
    return false;
  }

  const selectedNode = selected ? byId.get(selected) : undefined;

  function toggleState(state: MasteryState) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search topics or subjects"
          aria-label="Search topics"
          className="min-w-48 flex-1 rounded-lg border px-3 py-2 text-sm"
          style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
        />
        <div className="flex items-center gap-1">
          <button
            onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.15) * 100) / 100))}
            className="rounded-lg border px-2.5 py-2 text-sm"
            style={{ borderColor: 'var(--border)' }}
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            onClick={() => setZoom(1)}
            className="rounded-lg border px-2.5 py-2 text-xs tabular-nums"
            style={{ borderColor: 'var(--border)' }}
            aria-label="Reset zoom"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            onClick={() => setZoom((z) => Math.min(1.6, Math.round((z + 0.15) * 100) / 100))}
            className="rounded-lg border px-2.5 py-2 text-sm"
            style={{ borderColor: 'var(--border)' }}
            aria-label="Zoom in"
          >
            +
          </button>
        </div>
        {(selected || query || hidden.size > 0) && (
          <button
            onClick={() => {
              setSelected(null);
              setQuery('');
              setHidden(new Set());
            }}
            className="rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--border)' }}
          >
            Clear
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {STATES.map((state) => {
          const count = graph.nodes.filter((n) => n.state === state).length;
          if (count === 0) return null;
          const off = hidden.has(state);
          return (
            <button
              key={state}
              onClick={() => toggleState(state)}
              aria-pressed={!off}
              className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
              style={{
                borderColor: off ? 'var(--border)' : TONE[state],
                color: off ? 'var(--text-dim)' : TONE[state],
                opacity: off ? 0.5 : 1,
              }}
            >
              <span
                className="size-2 rounded-full"
                style={{ background: off ? 'var(--text-dim)' : TONE[state] }}
              />
              {MASTERY_LABELS[state].replace(' by demonstrated performance', '')} ({count})
            </button>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div
          className="card overflow-auto p-2"
          style={{ maxHeight: '32rem' }}
          role="group"
          aria-label="Knowledge graph"
        >
          <svg
            width={graph.width * zoom}
            height={graph.height * zoom}
            viewBox={`0 0 ${graph.width} ${graph.height}`}
            style={{ display: 'block' }}
          >
            <defs>
              <marker
                id="arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-ink-500)" />
              </marker>
            </defs>

            {graph.edges.map((e, i) => {
              const from = byId.get(e.from);
              const to = byId.get(e.to);
              if (!from || !to) return null;
              const lit =
                (!focusSet || (focusSet.has(e.from) && focusSet.has(e.to))) &&
                visible(from) &&
                visible(to);
              // Prerequisite arrows leave the right edge and enter the left,
              // which reads as "this comes before that".
              const x1 = from.x + NODE_W;
              const y1 = from.y + NODE_H / 2;
              const x2 = to.x;
              const y2 = to.y + NODE_H / 2;
              const mx = (x1 + x2) / 2;
              return (
                <path
                  key={i}
                  d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke="var(--color-ink-500)"
                  strokeWidth={1.25}
                  strokeDasharray={e.kind === 'related' ? '4 4' : undefined}
                  markerEnd={e.kind === 'prerequisite' ? 'url(#arrow)' : undefined}
                  opacity={lit ? 0.55 : 0.08}
                />
              );
            })}

            {graph.nodes.map((n) => {
              const isDim = dimmed(n);
              const isSelected = n.topicId === selected;
              return (
                <g
                  key={n.topicId}
                  transform={`translate(${n.x}, ${n.y})`}
                  opacity={isDim ? 0.22 : 1}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setSelected(isSelected ? null : n.topicId)}
                  role="button"
                  tabIndex={0}
                  aria-label={`${n.name}, ${MASTERY_LABELS[n.state]}`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelected(isSelected ? null : n.topicId);
                    }
                  }}
                >
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx={10}
                    fill="var(--surface-raised)"
                    stroke={TONE[n.state]}
                    strokeWidth={isSelected ? 2.5 : 1.25}
                  />
                  <rect width={4} height={NODE_H} rx={2} fill={TONE[n.state]} />
                  <text
                    x={14}
                    y={20}
                    fill="var(--text)"
                    fontSize={12.5}
                    fontWeight={500}
                  >
                    {n.name.length > 21 ? `${n.name.slice(0, 20)}…` : n.name}
                  </text>
                  <text x={14} y={37} fill="var(--text-dim)" fontSize={10.5}>
                    {n.attemptCount > 0
                      ? `${n.attemptCount} attempt${n.attemptCount === 1 ? '' : 's'}`
                      : 'no attempts'}
                    {n.dueCards ? ` · ${n.dueCards} due` : ''}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        <div className="card p-4">
          {selectedNode ? (
            <div className="space-y-3">
              <div>
                <div className="text-xs dim uppercase tracking-wide">
                  {selectedNode.subjectName}
                </div>
                <h3 className="text-base font-medium">{selectedNode.name}</h3>
                <span
                  className="mt-1 inline-block text-xs font-medium"
                  style={{ color: TONE[selectedNode.state] }}
                >
                  {MASTERY_LABELS[selectedNode.state]}
                </span>
              </div>

              <ul className="space-y-1 text-xs dim">
                {details[selectedNode.topicId]?.reasons.map((r, i) => (
                  <li key={i}>— {r}</li>
                ))}
              </ul>

              <p className="text-xs" style={{ color: 'var(--text)' }}>
                {details[selectedNode.topicId]?.nextStep}
              </p>

              <Relations
                label="Requires first"
                ids={selectedNode.prerequisiteIds}
                byId={byId}
                onPick={setSelected}
                onRemove={(id) => removeLink(id, 'requires')}
                disabled={pending}
              />
              <Relations
                label="Unlocks"
                ids={selectedNode.dependentIds}
                byId={byId}
                onPick={setSelected}
                onRemove={(id) => removeLink(id, 'unlocks')}
                disabled={pending}
              />
              <Relations
                label="Related"
                ids={selectedNode.relatedIds}
                byId={byId}
                onPick={setSelected}
                onRemove={(id) => removeLink(id, 'related')}
                disabled={pending}
              />

              <LinkEditor
                graph={graph}
                links={links}
                topicId={selectedNode.topicId}
                pending={pending}
                onAdd={(input) => runLinkChange(() => linkTopicsAction(input))}
              />

              {error && (
                <p className="text-xs" style={{ color: 'var(--color-danger)' }}>
                  {error}
                </p>
              )}
            </div>
          ) : (
            <div className="text-sm dim">
              <p className="mb-2" style={{ color: 'var(--text)' }}>
                Select a topic
              </p>
              <p className="text-xs">
                Clicking a node dims everything more than one hop away, so you can see what it
                depends on and what it unlocks.
              </p>
              <p className="mt-3 text-xs">
                Solid arrows are prerequisites and point left to right. Dashed lines are related
                topics with no ordering.
              </p>
            </div>
          )}
        </div>
      </div>

      {graph.cycles.length > 0 && (
        <p className="text-xs" style={{ color: 'var(--color-caution)' }}>
          {graph.cycles.length} circular prerequisite chain(s) detected — the layout places them
          by best effort. Fix the loop to get a meaningful ordering.
        </p>
      )}
    </div>
  );
}

type Relation = 'requires' | 'unlocks' | 'related';

function Relations({
  label,
  ids,
  byId,
  onPick,
  onRemove,
  disabled,
}: {
  label: string;
  ids: string[];
  byId: Map<string, GraphNode>;
  onPick: (id: string) => void;
  onRemove: (id: string) => void;
  disabled: boolean;
}) {
  if (ids.length === 0) return null;
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide dim">{label}</div>
      <ul className="mt-1 space-y-0.5">
        {ids.map((id) => {
          const node = byId.get(id);
          if (!node) return null;
          const weak = node.strength < SOLID_STRENGTH;
          return (
            <li key={id} className="flex items-center justify-between gap-2">
              <button
                onClick={() => onPick(id)}
                className="min-w-0 flex-1 truncate text-left text-xs underline-offset-2 hover:underline"
                style={{ color: weak ? TONE[node.state] : 'var(--text)' }}
              >
                {node.name}
                {weak ? ' ·  weak' : ''}
              </button>
              <button
                onClick={() => onRemove(id)}
                disabled={disabled}
                aria-label={`Remove link to ${node.name}`}
                title="Remove this link"
                className="shrink-0 px-1 text-xs disabled:opacity-40"
                style={{ color: 'var(--text-dim)' }}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const RELATION_OPTIONS: Array<{ id: Relation; label: string; hint: string }> = [
  { id: 'requires', label: 'Requires first', hint: 'the chosen topic must be learned before this one' },
  { id: 'unlocks', label: 'Unlocks', hint: 'this topic must be learned before the chosen one' },
  { id: 'related', label: 'Related', hint: 'connected, with no ordering between them' },
];

/**
 * Add a link from the selected topic.
 *
 * The candidate list is filtered by `linkCandidates`, so choices that would
 * be refused — itself, an existing link, or anything that would close a
 * circular prerequisite chain — are never offered. The database enforces the
 * same rules independently; this just avoids presenting a dead end.
 */
function LinkEditor({
  graph,
  links,
  topicId,
  pending,
  onAdd,
}: {
  graph: GraphData;
  links: TopicLink[];
  topicId: string;
  pending: boolean;
  onAdd: (input: {
    fromTopicId: string;
    toTopicId: string;
    kind: 'prerequisite' | 'related';
  }) => void;
}) {
  const [relation, setRelation] = useState<Relation>('requires');
  const [choice, setChoice] = useState('');

  const kind = relation === 'related' ? 'related' : 'prerequisite';
  const candidates = useMemo(
    () =>
      linkCandidates(
        graph,
        links,
        topicId,
        kind,
        relation === 'unlocks' ? 'unlocks' : 'requires',
      ),
    [graph, links, topicId, kind, relation],
  );

  // The selection is only valid for the relation it was made under.
  const valid = candidates.some((c) => c.topicId === choice);

  function submit() {
    if (!valid) return;
    onAdd({
      fromTopicId: relation === 'unlocks' ? topicId : choice,
      toTopicId: relation === 'unlocks' ? choice : topicId,
      kind,
    });
    setChoice('');
  }

  return (
    <div className="border-t pt-3" style={{ borderColor: 'var(--border)' }}>
      <div className="text-[11px] uppercase tracking-wide dim">Add a link</div>

      <div className="mt-2 flex flex-wrap gap-1">
        {RELATION_OPTIONS.map((option) => (
          <button
            key={option.id}
            onClick={() => {
              setRelation(option.id);
              setChoice('');
            }}
            aria-pressed={relation === option.id}
            title={option.hint}
            className="rounded-md border px-2 py-1 text-[11px]"
            style={{
              borderColor: relation === option.id ? 'var(--color-accent)' : 'var(--border)',
              color: relation === option.id ? 'var(--color-accent)' : 'var(--text-dim)',
            }}
          >
            {option.label}
          </button>
        ))}
      </div>

      <p className="mt-1.5 text-[11px] dim">
        {RELATION_OPTIONS.find((o) => o.id === relation)!.hint}
      </p>

      {candidates.length === 0 ? (
        <p className="mt-2 text-[11px] dim">
          No topic can be linked this way without creating a circular chain.
        </p>
      ) : (
        <div className="mt-2 flex gap-1.5">
          <select
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            aria-label="Topic to link"
            className="min-w-0 flex-1 rounded-md border px-2 py-1.5 text-xs"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
          >
            <option value="">Choose a topic…</option>
            {candidates.map((c) => (
              <option key={c.topicId} value={c.topicId}>
                {c.name} · {c.subjectName}
              </option>
            ))}
          </select>
          <button
            onClick={submit}
            disabled={!valid || pending}
            className="rounded-md px-2.5 py-1.5 text-xs font-medium disabled:opacity-40"
            style={{ background: 'var(--surface-hover)' }}
          >
            {pending ? '…' : 'Add'}
          </button>
        </div>
      )}
    </div>
  );
}
