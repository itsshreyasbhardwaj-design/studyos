import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGraph,
  prerequisiteGaps,
  readyToLearn,
  neighbourhood,
  searchNodes,
  MASTERY_STRENGTH,
  SOLID_STRENGTH,
  type TopicLink,
  type TopicNodeInput,
} from '../src/graph/graph.ts';
import type { MasteryState } from '../src/types.ts';

function topic(
  id: string,
  state: MasteryState,
  extra: Partial<TopicNodeInput> = {},
): TopicNodeInput {
  return {
    topicId: id,
    name: id,
    subjectId: 'maths',
    subjectName: 'Mathematics',
    state,
    attemptCount: state === 'not_started' ? 0 : 5,
    ...extra,
  };
}

const prereq = (from: string, to: string): TopicLink => ({
  fromTopicId: from,
  toTopicId: to,
  kind: 'prerequisite',
});

test('a chain of prerequisites lays out left to right', () => {
  const g = buildGraph(
    [topic('a', 'strong'), topic('b', 'learning'), topic('c', 'not_started')],
    [prereq('a', 'b'), prereq('b', 'c')],
  );
  const byId = new Map(g.nodes.map((n) => [n.topicId, n]));
  assert.equal(byId.get('a')!.layer, 0);
  assert.equal(byId.get('b')!.layer, 1);
  assert.equal(byId.get('c')!.layer, 2);
  assert.ok(byId.get('a')!.x < byId.get('b')!.x, 'prerequisites must sit to the left');
  assert.ok(byId.get('b')!.x < byId.get('c')!.x);
});

test('a node sits right of its deepest prerequisite, not its first', () => {
  // d depends on both a (depth 0) and c (depth 2), so d must be at depth 3.
  const g = buildGraph(
    [topic('a', 'strong'), topic('b', 'strong'), topic('c', 'strong'), topic('d', 'learning')],
    [prereq('a', 'b'), prereq('b', 'c'), prereq('a', 'd'), prereq('c', 'd')],
  );
  assert.equal(g.nodes.find((n) => n.topicId === 'd')!.layer, 3);
});

test('edges pointing at deleted topics are dropped, not drawn dangling', () => {
  const g = buildGraph([topic('a', 'strong')], [prereq('a', 'ghost'), prereq('ghost', 'a')]);
  assert.deepEqual(g.edges, []);
  assert.deepEqual(g.nodes[0].prerequisiteIds, []);
  assert.deepEqual(g.nodes[0].dependentIds, []);
});

test('a prerequisite cycle is reported instead of hanging', () => {
  const g = buildGraph(
    [topic('x', 'learning'), topic('y', 'learning')],
    [prereq('x', 'y'), prereq('y', 'x')],
  );
  assert.ok(g.cycles.length > 0, 'the cycle must be surfaced');
  assert.equal(g.nodes.length, 2, 'both nodes must still be placed');
  assert.ok(g.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));
});

test('layout is deterministic for the same input', () => {
  const topics = [topic('a', 'strong'), topic('b', 'learning'), topic('c', 'practising')];
  const links = [prereq('a', 'b'), prereq('a', 'c')];
  const first = buildGraph(topics, links);
  const second = buildGraph([...topics].reverse(), links);
  const pos = (g: typeof first) =>
    [...g.nodes].sort((p, q) => p.topicId.localeCompare(q.topicId)).map((n) => [n.topicId, n.x, n.y]);
  assert.deepEqual(pos(first), pos(second), 'input order must not change the drawing');
});

test('nodes never overlap within a subject band', () => {
  const topics = Array.from({ length: 8 }, (_, i) => topic(`t${i}`, 'learning'));
  const g = buildGraph(topics, []);
  const seen = new Set<string>();
  for (const n of g.nodes) {
    const key = `${n.x}:${n.y}`;
    assert.ok(!seen.has(key), `two nodes share position ${key}`);
    seen.add(key);
  }
});

test('separate subjects are placed in separate bands', () => {
  const g = buildGraph(
    [
      topic('m1', 'learning', { subjectId: 'maths', subjectName: 'Mathematics' }),
      topic('p1', 'learning', { subjectId: 'physics', subjectName: 'Physics' }),
    ],
    [],
  );
  const m = g.nodes.find((n) => n.topicId === 'm1')!;
  const p = g.nodes.find((n) => n.topicId === 'p1')!;
  assert.notEqual(m.y, p.y, 'subjects must not sit on top of each other');
  assert.ok(g.height > 0 && g.width > 0);
});

test('an empty graph produces a valid, non-negative canvas', () => {
  const g = buildGraph([], []);
  assert.deepEqual(g.nodes, []);
  assert.ok(g.width > 0 && g.height > 0);
});

// ---- prerequisite gaps: the actual point of the graph ----

test('a weak topic built on a weak prerequisite is reported as a gap', () => {
  const g = buildGraph(
    [
      topic('Differentiation', 'needs_revision'),
      topic('Integration', 'practising', { accuracy: 0.45 }),
    ],
    [prereq('Differentiation', 'Integration')],
  );
  const gaps = prerequisiteGaps(g);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].topicName, 'Integration');
  assert.equal(gaps[0].prerequisiteName, 'Differentiation');
  assert.match(gaps[0].reason, /needs revision/);
  assert.match(gaps[0].reason, /decayed/);
  assert.match(gaps[0].reason, /45% accuracy/);
});

test('a struggling topic with solid prerequisites is NOT reported as a gap', () => {
  // The foundation is fine, so the difficulty lies elsewhere. Saying otherwise
  // would send the student to revise the wrong thing.
  const g = buildGraph(
    [topic('Differentiation', 'mastered'), topic('Integration', 'learning', { accuracy: 0.3 })],
    [prereq('Differentiation', 'Integration')],
  );
  assert.deepEqual(prerequisiteGaps(g), []);
});

test('a solid topic is never reported as blocked', () => {
  const g = buildGraph(
    [topic('Vectors', 'learning'), topic('Mechanics', 'mastered')],
    [prereq('Vectors', 'Mechanics')],
  );
  assert.deepEqual(prerequisiteGaps(g), []);
});

test('an untouched topic is not treated as evidence of a foundation problem', () => {
  const g = buildGraph(
    [topic('Basics', 'learning'), topic('Advanced', 'not_started')],
    [prereq('Basics', 'Advanced')],
  );
  assert.deepEqual(prerequisiteGaps(g), [], 'never started is not the same as struggling');
});

test('a foundation many topics depend on outranks one with a single dependent', () => {
  const g = buildGraph(
    [
      topic('Shared', 'learning'),
      topic('Narrow', 'learning'),
      topic('A', 'practising', { accuracy: 0.5 }),
      topic('B', 'practising', { accuracy: 0.5 }),
      topic('C', 'practising', { accuracy: 0.5 }),
      topic('D', 'practising', { accuracy: 0.5 }),
    ],
    [prereq('Shared', 'A'), prereq('Shared', 'B'), prereq('Shared', 'C'), prereq('Narrow', 'D')],
  );
  const gaps = prerequisiteGaps(g);
  assert.equal(gaps[0].prerequisiteName, 'Shared');
  assert.match(gaps[0].reason, /3 topics build on it/);
});

test('gap ordering is stable for identical severities', () => {
  const g = buildGraph(
    [topic('p', 'learning'), topic('z', 'practising'), topic('a', 'practising')],
    [prereq('p', 'z'), prereq('p', 'a')],
  );
  const first = prerequisiteGaps(g).map((x) => x.topicId);
  const second = prerequisiteGaps(g).map((x) => x.topicId);
  assert.deepEqual(first, second);
  assert.deepEqual(first, ['a', 'z']);
});

// ---- ready to learn ----

test('a topic with all prerequisites solid is ready to learn', () => {
  const g = buildGraph(
    [
      topic('Algebra', 'mastered'),
      topic('Trig', 'strong'),
      topic('Calculus', 'not_started'),
      topic('Blocked', 'not_started'),
      topic('Shaky', 'learning'),
    ],
    [
      prereq('Algebra', 'Calculus'),
      prereq('Trig', 'Calculus'),
      prereq('Shaky', 'Blocked'),
    ],
  );
  const ready = readyToLearn(g).map((r) => r.topicId);
  assert.ok(ready.includes('Calculus'), 'both prerequisites are solid');
  assert.ok(!ready.includes('Blocked'), 'its prerequisite is still weak');
  const calculus = readyToLearn(g).find((r) => r.topicId === 'Calculus')!;
  assert.equal(calculus.prerequisiteCount, 2);
  assert.match(calculus.reason, /all 2 prerequisites are solid/);
});

test('a topic with no prerequisites is ready and says so', () => {
  const g = buildGraph([topic('Standalone', 'not_started')], []);
  const ready = readyToLearn(g);
  assert.equal(ready[0].reason, 'no prerequisites');
});

test('already-strong topics are not suggested as ready to learn', () => {
  const g = buildGraph([topic('Done', 'mastered'), topic('Solid', 'strong')], []);
  assert.deepEqual(readyToLearn(g), []);
});

// ---- navigation helpers ----

test('neighbourhood walks prerequisites, dependents and related links', () => {
  const g = buildGraph(
    [topic('a', 'strong'), topic('b', 'learning'), topic('c', 'learning'), topic('far', 'learning')],
    [prereq('a', 'b'), prereq('b', 'c'), { fromTopicId: 'b', toTopicId: 'far', kind: 'related' }],
  );
  const one = neighbourhood(g, 'b', 1);
  assert.deepEqual([...one].sort(), ['a', 'b', 'c', 'far']);
  const zero = neighbourhood(g, 'b', 0);
  assert.deepEqual([...zero], ['b']);
});

test('neighbourhood terminates on a cycle', () => {
  const g = buildGraph(
    [topic('x', 'learning'), topic('y', 'learning')],
    [prereq('x', 'y'), prereq('y', 'x')],
  );
  assert.deepEqual([...neighbourhood(g, 'x', 5)].sort(), ['x', 'y']);
});

test('search matches topic and subject names, and ignores empty queries', () => {
  const g = buildGraph(
    [
      topic('Integration', 'learning'),
      topic('Forces', 'learning', { subjectId: 'physics', subjectName: 'Physics HL' }),
    ],
    [],
  );
  assert.deepEqual(searchNodes(g, 'integ').map((n) => n.topicId), ['Integration']);
  assert.deepEqual(searchNodes(g, 'physics').map((n) => n.topicId), ['Forces']);
  assert.deepEqual(searchNodes(g, '  '), []);
});

test('decayed knowledge does not count as a solid foundation', () => {
  // needs_revision means "known once, since decayed". Ranking it as solid
  // would hide exactly the gaps this view exists to find.
  assert.ok(MASTERY_STRENGTH.needs_revision < SOLID_STRENGTH);
  assert.equal(MASTERY_STRENGTH.needs_revision, MASTERY_STRENGTH.learning);
  assert.ok(MASTERY_STRENGTH.strong >= SOLID_STRENGTH);
  assert.ok(MASTERY_STRENGTH.mastered >= SOLID_STRENGTH);
});
