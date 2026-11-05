# Architecture

## Shape

```
packages/core   zero-dependency domain engines (TypeScript, no build step)
packages/db     node:sqlite persistence, migrations, repositories
apps/web        Next.js 16 App Router UI over the above
```

The dependency arrow points one way: `web → db → core`. The core knows nothing
about SQL, React or Next. That is what lets the same engines run in a test
process, a server component, and later a desktop or mobile shell.

## Why there is no build step for the domain packages

Node 24 runs TypeScript directly (type stripping) and ships SQLite in the
standard library. So `packages/core` and `packages/db` are plain `.ts` source
with explicit `.ts` import specifiers, executed as-is by `node --test`. Next
compiles the same files through `transpilePackages`.

The payoff: `pnpm install` pulls no native modules, needs no C toolchain, and
the test suite runs in ~0.5s with no compile step. The cost: imports carry
`.ts` extensions, which is unusual to read.

## The one idea the design is organised around

**A number's origin travels with the number.**

`Provenance` is `measured | inferred | confirmed | demonstrated`, and
`Provenanced<T>` wraps any value that reaches a user. This is not decoration:

- `aggregateEvents` reports `conflictMs` when devices overlap, and the analytics
  layer *automatically downgrades* active-time figures from `measured` to
  `inferred` when any overlap occurred, because pro-rating happened.
- `assessMastery` is given no access to study duration at all. A test asserts
  its source contains no duration identifier. Hours and learning are kept
  structurally separate rather than separated by convention.
- A never-reviewed flashcard reports `predictedRetention: undefined`, not `0`.
  "Never studied" and "completely forgotten" are different claims.

## Time aggregation

Multiple devices reporting simultaneously is the normal case, not an edge case.
Summing their durations triple-counts the same hour, so:

1. All intervals are clipped to the query window.
2. A sweep line splits them at every boundary.
3. Each elementary slice is attributed to exactly **one** event, chosen by
   provenance rank, then active-time density, then id — deterministic, so the
   same data always totals the same.
4. Category, subject and device breakdowns therefore sum to `elapsedMs` exactly.

Conflicts are counted and surfaced rather than silently resolved.

## Revision

FSRS-4.5 with the published default weights. The defining property —
`R(t = S) = 0.9` exactly — is asserted in the test suite, because if the
FACTOR/DECAY pair drifts, every interval in the product is wrong.

Same-day repeats deliberately hold long-term stability rather than inventing
growth: FSRS-4.5 has no short-term component, and that limitation is documented
in code rather than papered over.

The queue is capped and triaged. Serving 400 overdue cards is how people
abandon review habits, so the most at-risk and exam-relevant come first and the
remainder is reported as a backlog with a drain estimate. Interleaving across
subjects is a default, not a setting.

## Planning

Deterministic and explainable, not a model call. Topological ordering for
dependencies (cycles are reported, not silently dropped), then urgency scoring
from deadline slack, priority and exam proximity. Revision time is reserved
*before* task work because it is time-sensitive in a way task work is not.

The planner's most important output is the admission of failure: `unscheduled`,
`risks` and `feasible` exist so the UI can say "this does not fit" instead of
rendering a plan that quietly drops work.

## Knowledge graph

A graph drawing that only shows which topics exist is decoration. What earns
the view its place is what the structure makes computable:

- **`prerequisiteGaps`** — fires only when the dependent topic is not solid
  **and** a prerequisite is not solid. A topic someone finds hard *despite*
  strong foundations is a different problem; claiming a foundation gap there
  would send them to revise the wrong thing.
- **`readyToLearn`** — the inverse, and the more actionable half: not-yet-started
  topics whose prerequisites are all solid.

`needs_revision` deliberately ranks as weak, level with `learning`. It means
the topic was known once and has decayed, and decayed knowledge is not a
foundation to build on. Ranking it as solid would hide exactly the gaps this
view exists to find.

Circular prerequisite chains are refused at the **repository**, not in the
form handler, so the rule holds for every caller. The editor additionally
filters its own candidate list with the same pure function, so the UI never
offers a choice that the write would reject — but the filter is a courtesy and
the repository is the boundary. `buildGraph` still *detects* cycles, because
links predating the rule, or written straight to the database, can exist.

Layout is longest-path layering with stable tie-breaks, grouped into subject
bands — so every prerequisite arrow points rightward, the same data always
draws the same graph, and positions can be asserted in tests. No physics
simulation, and no 3D: neither would add information.

## Persistence

- Foreign keys are enabled explicitly (`PRAGMA foreign_keys = ON`). Without it
  every `ON DELETE CASCADE` is decoration and account deletion leaks rows — a
  test asserts the cascade works.
- Activity events are append-only. A correction inserts a superseding row and
  writes an audit entry; reads filter superseded rows. History stays auditable.
- Note edits snapshot the previous body before overwriting. A retitle or a
  reattach does not snapshot — there is no writing to lose — so history stays
  a record of the text, not of every field touched.
- Search input never reaches FTS5 as typed. `ftsQuery` splits it on the same
  character classes the `unicode61` tokeniser uses and requotes each token, so
  the query language is unreachable from the search box: FTS5 syntax in the
  input is matched as text rather than parsed, and nothing a user types is a
  syntax error. A one-character token is matched exactly rather than as a
  prefix, because prefix-matching one letter returns most of the corpus ranked
  as though it were relevant.
- A note's topic is checked for ownership on write. The foreign key proves the
  topic exists; only the ownership check proves it is the writer's.
- The offline mutation queue is idempotent on `(device_id, seq)`, which makes
  at-least-once delivery safe.

## Web layer

Server components read through `lib/queries.ts`, which composes the core
engines over repository reads. Mutations are server actions. There is no API
layer, because there is no second client yet; adding one would mean exposing
the repository functions over HTTP, not restructuring.

One sharp edge worth knowing: `node:sqlite` returns null-prototype rows, which
React cannot serialise across the server/client boundary. Anything handed to a
client component is rebuilt as a plain object literal.
