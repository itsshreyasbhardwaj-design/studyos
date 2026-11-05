/**
 * Personal learning knowledge graph.
 *
 * The point of this module is not the picture. A graph drawing that only
 * shows which topics exist is decoration. What earns its place is the
 * analysis the structure makes possible:
 *
 *   - `prerequisiteGaps` — you are stuck on Integration *because* your
 *     Differentiation is weak. That is a causal claim the flat subject list
 *     cannot make.
 *   - `readyToLearn` — everything this topic depends on is solid, so starting
 *     it now is a good use of time.
 *
 * Layout is deterministic (longest-path layering, stable tie-breaks), so the
 * same data always draws the same graph and the positions can be tested.
 */

import type { MasteryState } from '../types.ts';

/**
 * How much a mastery state counts as "this prerequisite is solid".
 *
 * Note that `needs_revision` ranks as weak, level with `learning`. It means
 * the topic was known once and has decayed — for the purposes of building
 * something on top of it, decayed knowledge is not a foundation.
 */
export const MASTERY_STRENGTH: Record<MasteryState, number> = {
  not_started: 0,
  learning: 1,
  needs_revision: 1,
  practising: 2,
  strong: 3,
  mastered: 4,
};

/** At or above this strength, a prerequisite is treated as solid. */
export const SOLID_STRENGTH = 3;

export type LinkKind = 'prerequisite' | 'related';

export interface TopicLink {
  /** For `prerequisite`, this topic must be learned first. */
  fromTopicId: string;
  toTopicId: string;
  kind: LinkKind;
}

export interface TopicNodeInput {
  topicId: string;
  name: string;
  subjectId: string;
  subjectName?: string;
  state: MasteryState;
  accuracy?: number;
  predictedRetention?: number;
  attemptCount: number;
  /** Cards in this topic that are due now. */
  dueCards?: number;
}

export interface GraphNode extends TopicNodeInput {
  strength: number;
  /** Longest prerequisite chain ending at this node. Column in the layout. */
  layer: number;
  prerequisiteIds: string[];
  dependentIds: string[];
  relatedIds: string[];
  x: number;
  y: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: LinkKind;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Prerequisite cycles, reported rather than silently broken. */
  cycles: string[][];
  width: number;
  height: number;
}

export interface LayoutOptions {
  columnGap?: number;
  rowGap?: number;
  /** Vertical gap inserted between subject bands. */
  bandGap?: number;
  padding?: number;
}

const DEFAULTS: Required<LayoutOptions> = {
  columnGap: 210,
  rowGap: 76,
  bandGap: 48,
  padding: 60,
};

export function buildGraph(
  topics: readonly TopicNodeInput[],
  links: readonly TopicLink[],
  options: LayoutOptions = {},
): KnowledgeGraph {
  const opts = { ...DEFAULTS, ...options };
  const known = new Set(topics.map((t) => t.topicId));

  // Drop edges pointing at topics that no longer exist, so a deleted topic
  // cannot leave a dangling arrow on the canvas.
  const edges: GraphEdge[] = links
    .filter((l) => known.has(l.fromTopicId) && known.has(l.toTopicId))
    .map((l) => ({ from: l.fromTopicId, to: l.toTopicId, kind: l.kind }));

  const prerequisites = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  const related = new Map<string, string[]>();
  for (const id of known) {
    prerequisites.set(id, []);
    dependents.set(id, []);
    related.set(id, []);
  }
  for (const e of edges) {
    if (e.kind === 'prerequisite') {
      prerequisites.get(e.to)!.push(e.from);
      dependents.get(e.from)!.push(e.to);
    } else {
      related.get(e.from)!.push(e.to);
      related.get(e.to)!.push(e.from);
    }
  }

  const { layers, cycles } = computeLayers(topics, prerequisites);

  const nodes: GraphNode[] = topics.map((t) => ({
    ...t,
    strength: MASTERY_STRENGTH[t.state],
    layer: layers.get(t.topicId) ?? 0,
    prerequisiteIds: (prerequisites.get(t.topicId) ?? []).slice().sort(),
    dependentIds: (dependents.get(t.topicId) ?? []).slice().sort(),
    relatedIds: [...new Set(related.get(t.topicId) ?? [])].sort(),
    x: 0,
    y: 0,
  }));

  const { width, height } = layoutNodes(nodes, opts);
  return { nodes, edges, cycles, width, height };
}

/**
 * Longest-path layering. A node sits one column right of its deepest
 * prerequisite, so every prerequisite arrow points rightward — which is what
 * makes the drawing readable without a physics simulation.
 *
 * Cycles are detected and reported; nodes inside one are placed at the depth
 * reached before the cycle closed rather than recursing forever.
 */
function computeLayers(
  topics: readonly TopicNodeInput[],
  prerequisites: ReadonlyMap<string, string[]>,
): { layers: Map<string, number>; cycles: string[][] } {
  const layers = new Map<string, number>();
  const visiting = new Set<string>();
  const cycles: string[][] = [];

  const depth = (id: string, stack: string[]): number => {
    const cached = layers.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) {
      cycles.push([...stack.slice(stack.indexOf(id)), id]);
      return 0;
    }
    visiting.add(id);
    const deps = prerequisites.get(id) ?? [];
    let best = 0;
    for (const dep of [...deps].sort()) {
      best = Math.max(best, depth(dep, [...stack, id]) + 1);
    }
    visiting.delete(id);
    layers.set(id, best);
    return best;
  };

  // Sorted so the layering — and therefore the whole drawing — is stable.
  for (const t of [...topics].sort((a, b) => a.topicId.localeCompare(b.topicId))) {
    depth(t.topicId, []);
  }
  return { layers, cycles };
}

/**
 * Place nodes in subject bands: each subject occupies a horizontal band, and
 * within it a node's column is its prerequisite depth. Grouping by subject
 * keeps a multi-subject graph legible, which a global force layout does not.
 */
function layoutNodes(
  nodes: GraphNode[],
  opts: Required<LayoutOptions>,
): { width: number; height: number } {
  const bands = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    const band = bands.get(n.subjectId);
    if (band) band.push(n);
    else bands.set(n.subjectId, [n]);
  }

  const orderedBands = [...bands.entries()].sort((a, b) =>
    (a[1][0].subjectName ?? a[0]).localeCompare(b[1][0].subjectName ?? b[0]),
  );

  let cursorY = opts.padding;
  let maxLayer = 0;

  for (const [, band] of orderedBands) {
    const byLayer = new Map<number, GraphNode[]>();
    for (const n of band) {
      const list = byLayer.get(n.layer);
      if (list) list.push(n);
      else byLayer.set(n.layer, [n]);
    }

    let rowsInBand = 0;
    for (const [layer, group] of byLayer) {
      maxLayer = Math.max(maxLayer, layer);
      group.sort((a, b) => a.name.localeCompare(b.name));
      group.forEach((node, i) => {
        node.x = opts.padding + layer * opts.columnGap;
        node.y = cursorY + i * opts.rowGap;
      });
      rowsInBand = Math.max(rowsInBand, group.length);
    }
    cursorY += rowsInBand * opts.rowGap + opts.bandGap;
  }

  return {
    width: opts.padding * 2 + maxLayer * opts.columnGap + 180,
    height: Math.max(cursorY - opts.bandGap + opts.padding, opts.padding * 2),
  };
}

// ---------- analysis ----------

/**
 * Would adding `from → to` as a prerequisite close a loop?
 *
 * Edges run prerequisite → dependent, so the new edge creates a cycle exactly
 * when `from` is already reachable from `to`. Only prerequisite edges are
 * considered: `related` links carry no ordering, so they cannot form one.
 *
 * This is the check that keeps circular chains out of the data in the first
 * place. `buildGraph` still detects cycles, because links predating this rule
 * (or written directly to the database) can exist.
 */
export function wouldCreateCycle(
  links: readonly TopicLink[],
  fromTopicId: string,
  toTopicId: string,
): boolean {
  if (fromTopicId === toTopicId) return true;

  const dependents = new Map<string, string[]>();
  for (const l of links) {
    if (l.kind !== 'prerequisite') continue;
    const list = dependents.get(l.fromTopicId);
    if (list) list.push(l.toTopicId);
    else dependents.set(l.fromTopicId, [l.toTopicId]);
  }

  // Walk forward from `to`; reaching `from` means the new edge closes a loop.
  const seen = new Set<string>([toTopicId]);
  const queue = [toTopicId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (id === fromTopicId) return true;
    for (const next of dependents.get(id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/**
 * Topics that may legally become a new prerequisite of `topicId` — excludes
 * itself, anything already linked to it, and anything that would close a loop.
 * Used to populate the editor so the UI cannot offer a choice that will fail.
 */
export function linkCandidates(
  graph: KnowledgeGraph,
  links: readonly TopicLink[],
  topicId: string,
  kind: LinkKind,
  direction: 'requires' | 'unlocks' = 'requires',
): GraphNode[] {
  const existing = new Set(
    links
      .filter((l) => l.fromTopicId === topicId || l.toTopicId === topicId)
      .map((l) => (l.fromTopicId === topicId ? l.toTopicId : l.fromTopicId)),
  );

  return graph.nodes
    .filter((n) => n.topicId !== topicId && !existing.has(n.topicId))
    .filter((n) => {
      if (kind !== 'prerequisite') return true;
      return direction === 'requires'
        ? !wouldCreateCycle(links, n.topicId, topicId)
        : !wouldCreateCycle(links, topicId, n.topicId);
    })
    .sort(
      (a, b) =>
        (a.subjectName ?? '').localeCompare(b.subjectName ?? '') ||
        a.name.localeCompare(b.name),
    );
}

export interface PrerequisiteGap {
  /** The topic that is struggling. */
  topicId: string;
  topicName: string;
  /** The weaker topic it is built on. */
  prerequisiteId: string;
  prerequisiteName: string;
  subjectId: string;
  severity: number;
  reason: string;
}

/**
 * Find topics whose difficulty is plausibly explained by a weak foundation.
 *
 * Reported only when BOTH sides hold: the dependent topic is not yet solid,
 * and a prerequisite is not solid either. A struggling topic with strong
 * prerequisites is a different problem, and saying otherwise would send the
 * user to revise something that is not actually the cause.
 */
export function prerequisiteGaps(graph: KnowledgeGraph): PrerequisiteGap[] {
  const byId = new Map(graph.nodes.map((n) => [n.topicId, n]));
  const gaps: PrerequisiteGap[] = [];

  for (const node of graph.nodes) {
    if (node.strength >= SOLID_STRENGTH) continue;
    // A topic nobody has attempted is not evidence of a foundation problem.
    if (node.attemptCount === 0 && node.state === 'not_started') continue;

    for (const prereqId of node.prerequisiteIds) {
      const prereq = byId.get(prereqId);
      if (!prereq || prereq.strength >= SOLID_STRENGTH) continue;

      const reasons: string[] = [];
      // The weaker the foundation, the more it explains.
      let severity = (SOLID_STRENGTH - prereq.strength) * 20;
      reasons.push(`${prereq.name} is ${prereq.state.replace(/_/g, ' ')}`);

      if (prereq.state === 'needs_revision') {
        severity += 15;
        reasons.push('it was known once and has decayed');
      }
      if (node.accuracy !== undefined && node.accuracy < 0.6) {
        severity += (0.6 - node.accuracy) * 50;
        reasons.push(`${node.name} is at ${(node.accuracy * 100).toFixed(0)}% accuracy`);
      }
      if (prereq.attemptCount === 0) {
        severity += 10;
        reasons.push('no graded attempts on the prerequisite');
      }
      // A weak foundation that many topics stand on matters more.
      if (prereq.dependentIds.length > 1) {
        severity += prereq.dependentIds.length * 5;
        reasons.push(`${prereq.dependentIds.length} topics build on it`);
      }

      gaps.push({
        topicId: node.topicId,
        topicName: node.name,
        prerequisiteId: prereq.topicId,
        prerequisiteName: prereq.name,
        subjectId: node.subjectId,
        severity,
        reason: reasons.join(' · '),
      });
    }
  }

  return gaps.sort(
    (a, b) =>
      b.severity - a.severity ||
      a.topicId.localeCompare(b.topicId) ||
      a.prerequisiteId.localeCompare(b.prerequisiteId),
  );
}

export interface ReadyTopic {
  topicId: string;
  name: string;
  subjectId: string;
  prerequisiteCount: number;
  reason: string;
}

/**
 * Topics worth starting now: not yet begun, and every prerequisite is solid.
 * The inverse of a gap, and the more actionable half for a student deciding
 * what to pick up next.
 */
export function readyToLearn(graph: KnowledgeGraph): ReadyTopic[] {
  const byId = new Map(graph.nodes.map((n) => [n.topicId, n]));
  return graph.nodes
    .filter((n) => n.state === 'not_started' || n.state === 'learning')
    .filter((n) =>
      n.prerequisiteIds.every((id) => (byId.get(id)?.strength ?? 0) >= SOLID_STRENGTH),
    )
    .map((n) => ({
      topicId: n.topicId,
      name: n.name,
      subjectId: n.subjectId,
      prerequisiteCount: n.prerequisiteIds.length,
      reason:
        n.prerequisiteIds.length === 0
          ? 'no prerequisites'
          : `all ${n.prerequisiteIds.length} prerequisite${n.prerequisiteIds.length === 1 ? '' : 's'} are solid`,
    }))
    .sort(
      (a, b) => b.prerequisiteCount - a.prerequisiteCount || a.name.localeCompare(b.name),
    );
}

/** Ids within `depth` prerequisite/related hops of `topicId`, inclusive. */
export function neighbourhood(
  graph: KnowledgeGraph,
  topicId: string,
  depth = 1,
): Set<string> {
  const byId = new Map(graph.nodes.map((n) => [n.topicId, n]));
  const seen = new Set<string>([topicId]);
  let frontier = [topicId];

  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      const node = byId.get(id);
      if (!node) continue;
      for (const neighbour of [
        ...node.prerequisiteIds,
        ...node.dependentIds,
        ...node.relatedIds,
      ]) {
        if (!seen.has(neighbour)) {
          seen.add(neighbour);
          next.push(neighbour);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

/** Case-insensitive topic/subject name search, for the graph's search box. */
export function searchNodes(graph: KnowledgeGraph, query: string): GraphNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return graph.nodes
    .filter(
      (n) =>
        n.name.toLowerCase().includes(q) ||
        (n.subjectName ?? '').toLowerCase().includes(q),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}
