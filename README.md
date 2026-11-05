# StudyOS

A local-first study, revision and productivity system. Plans your work from real
deadlines, tracks time without double-counting it, schedules revision with FSRS,
and separates *time spent* from *learning demonstrated* — structurally, not just
in the copy.

Runs with no account, no server, no API key and no network.

## Quick start

```bash
pnpm install
pnpm dev
```

Open http://localhost:3111. First run seeds a sample IB student so the UI is not
empty; delete `studyos.db` to start clean.

```bash
pnpm test        # 114 tests, no build step, ~0.5s
pnpm build       # production build of the web app
```

Requires Node 24+ (for `node:sqlite` and native TypeScript execution) and pnpm.

## What it does

- **Command Center** — today's recorded time, what to do next and why, due
  revision, upcoming exams, open tasks.
- **Focus** — timer with modes, linked to a subject and task. Elapsed and active
  time are tracked separately; pauses reduce active time only.
- **Planner** — deterministic scheduling against real free time and deadlines,
  with dependency ordering, protected revision time, what-if scenarios, and an
  explicit verdict when the week does not fit.
- **Subjects** — per-topic mastery derived from graded performance and modelled
  retention. Study hours are displayed beside mastery and deliberately excluded
  from it.
- **Revision** — FSRS-4.5 queue with interleaving, backlog triage, and a
  forgetfulness radar that states its evidence for every row.
- **Analytics** — 30-day trends, consistency measured by days shown up rather
  than hours piled on, subject and category breakdowns.
- **Daily Report** — assembled from records, with every figure labelled by
  origin and a data-quality section listing what needs correcting.

## The rule the codebase is built around

Every number that reaches a user carries its origin:

| Label | Meaning |
|---|---|
| `measured` | Recorded by a timer or device |
| `confirmed` | A human stated it |
| `demonstrated` | Proven by graded performance |
| `inferred` | Modelled — may be wrong, and says so |

Three consequences that are enforced in code rather than by convention:

- Overlapping device reports downgrade affected figures to `inferred`
  automatically, because attribution involved a tie-break.
- `assessMastery` receives no study-duration input at all; a test asserts this.
- A never-reviewed card reports *no* retention rather than 0%.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — structure and the reasoning
- [`docs/platform-capabilities.md`](docs/platform-capabilities.md) — what is built, per platform
- [`docs/limitations.md`](docs/limitations.md) — deviations, weaknesses, what was and was not verified

## Status

The web app is built and verified in a browser. Desktop, mobile and the browser
extension are **not built** — see the capability matrix for why, and for the
honest fallback each one has.
