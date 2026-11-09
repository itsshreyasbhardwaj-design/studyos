# StudyOS

[![CI](https://github.com/itsshreyasbhardwaj-design/studyos/actions/workflows/ci.yml/badge.svg)](https://github.com/itsshreyasbhardwaj-design/studyos/actions/workflows/ci.yml)

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
pnpm test        # 195 tests, no build step, ~0.5s
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
- **Model check** — replays your own review log to ask whether FSRS actually
  describes you, reports predicted against observed recall with the sampling
  error, and fits one durability parameter. It refuses to fit below 100 scored
  reviews or 20 lapses, and refuses again when the 95% interval contains 1.
- **Knowledge graph** — topics laid out by prerequisite depth, coloured by
  mastery. Its real output is the analysis: *weak foundations* names the
  prerequisite that plausibly explains a topic you're stuck on, and *ready to
  learn* names what's cheapest to start next. Prerequisites are editable from
  the panel, and circular chains are refused at the database boundary.
- **Notes** — plain-text notes attached to the topic they belong to, with
  full-text search and a kept copy of every body an edit replaced. Search
  input is tokenised before it reaches FTS5, so what a student actually types
  — `C++`, `what?`, an unclosed quote — is a query, not an error.
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
- The scheduler's own accuracy is measured against your log and reported, and
  a correction is refused when the evidence cannot distinguish you from the
  population the published weights were fitted to.
- The graph reports a foundation gap only when the struggling topic *and* a
  prerequisite are both weak — a hard topic with solid prerequisites is a
  different problem, and the panel stays quiet about it.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — structure and the reasoning
- [`docs/platform-capabilities.md`](docs/platform-capabilities.md) — what is built, per platform
- [`docs/limitations.md`](docs/limitations.md) — deviations, weaknesses, what was and was not verified

## Status

The web app is built and verified in a browser. Desktop, mobile and the browser
extension are **not built** — see the capability matrix for why, and for the
honest fallback each one has.
