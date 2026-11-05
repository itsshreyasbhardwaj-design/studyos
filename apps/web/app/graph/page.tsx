import { loadGraph } from '../../lib/queries.ts';
import { Card, Empty } from '../ui.tsx';
import { GraphCanvas } from './canvas.tsx';

export const dynamic = 'force-dynamic';

export default function GraphPage() {
  const { graph, gaps, ready, details } = loadGraph();

  // One row per struggling topic: its single most-explanatory weak foundation.
  // Listing every weak prerequisite separately buries the signal.
  const topGaps = gaps.filter(
    (g, i) => gaps.findIndex((other) => other.topicId === g.topicId) === i,
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Knowledge graph</h1>
        <p className="text-sm dim mt-1">
          {graph.nodes.length} topics, {graph.edges.length} links. Node colour is mastery from
          graded evidence — the same scale used on the Subjects page.
        </p>
      </header>

      {graph.nodes.length === 0 ? (
        <Card>
          <Empty title="No topics yet" hint="Add subjects and topics to build the graph." />
        </Card>
      ) : (
        <GraphCanvas graph={graph} details={details} />
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Weak foundations">
          {topGaps.length === 0 ? (
            <Empty
              title="No foundation gaps found"
              hint="Every struggling topic currently rests on solid prerequisites."
            />
          ) : (
            <>
              <ul className="space-y-3">
                {topGaps.slice(0, 8).map((g) => (
                  <li key={`${g.topicId}-${g.prerequisiteId}`} className="text-sm">
                    <div>
                      <span style={{ color: 'var(--color-caution)' }}>{g.topicName}</span>
                      <span className="dim"> is held back by </span>
                      <span style={{ color: 'var(--color-danger)' }}>{g.prerequisiteName}</span>
                    </div>
                    <div className="mt-0.5 text-xs dim">{g.reason}</div>
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-xs dim">
                Reported only when the dependent topic is not yet solid <em>and</em> a
                prerequisite is not solid either. A topic you find hard despite strong
                foundations is a different problem, and this panel stays quiet about it rather
                than sending you to revise the wrong thing.
              </p>
            </>
          )}
        </Card>

        <Card title="Ready to learn">
          {ready.length === 0 ? (
            <Empty
              title="Nothing queued up"
              hint="New topics appear here once their prerequisites are solid."
            />
          ) : (
            <>
              <ul className="space-y-2.5">
                {ready.slice(0, 8).map((r) => (
                  <li key={r.topicId} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate">{r.name}</span>
                    <span className="shrink-0 text-xs dim">{r.reason}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-xs dim">
                Topics not yet started whose prerequisites are all strong or mastered — the
                cheapest places to make progress next.
              </p>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
