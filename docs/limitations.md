# Known limitations and deliberate deviations

## Deviations from the original brief, with reasons

### 1. SQLite instead of Supabase/Postgres

The brief specified Supabase for database, auth, storage and realtime.

This build uses `node:sqlite` — SQLite from the Node standard library — because
a hosted Postgres requires an account and, past the free tier, money. The
operating constraint for this project is that it must run with zero spend and
zero accounts.

**What is preserved:** the schema is ordinary relational SQL with foreign keys,
constraints and indexes. Row Level Security is approximated by scoping every
query to a `user_id`, which is tested. Porting to Postgres is a migration-file
translation plus turning the scoping into real RLS policies, not a redesign.

**What is lost:** no managed auth, no realtime subscriptions, no hosted storage.

### 2. No Tauri desktop app

Tauri requires a Rust toolchain. This machine has neither Rust nor Homebrew,
and installing a toolchain was outside the scope of the request. The desktop
app is therefore **not built**, and no desktop build has been verified.

### 3. No AI features

Every AI feature in the brief — tutor, Master Notes generation, oral examiner,
agents, conversational analytics — requires a model API, which costs money per
call. The standing constraint on this project is that no task may spend money
on API calls.

Rather than ship fake AI, the system was designed so the valuable parts work
without it:

- Scheduling, revision, mastery and analytics are **deterministic**. They were
  never going to be better as model calls; arithmetic over records is more
  accurate, runs offline, costs nothing and can explain itself.
- The report's "observations" are rule outputs, labelled as such on the page.
- `Provenance` already distinguishes measured, inferred, confirmed and
  demonstrated values, so AI-generated content has a place to slot in with
  correct labelling when a key is available.

This is the brief's own principle — "the application should be exceptionally
useful even without AI features enabled" — taken seriously.

### 4. No mobile app, no browser extension

Neither could be verified here (no device, no simulator, no extension store
review). The brief says not to claim unverified builds, so they are absent
rather than stubbed. The tracking schema is designed for them: an extension or
mobile client posts `ActivityEvent` rows and the overlap-safe aggregation
already handles multiple simultaneous devices.

## Known weaknesses in what *is* built

- **FSRS weights are the published defaults.** They are not fitted to any
  individual. The `review_log` table captures exactly what an optimiser needs,
  and `revision_params` can store per-user weights, but no optimiser is
  implemented.
- **The planner is greedy, not optimal.** It fills free time in priority order
  with a dependency constraint. It will not find the globally best packing of a
  tightly constrained week. It is deterministic and explainable, which was
  judged the better trade for a study planner.
- **Time zones are handled by host offset.** `dayWindow` uses the host's offset.
  A user crossing time zones mid-day will see day boundaries shift. The schema
  stores a per-user timezone, but it is not yet threaded through the analytics.
- **Topic links are seeded, not inferred.** The knowledge graph draws the
  prerequisite edges it is given. Nothing infers them from a syllabus, and
  there is no UI for editing links yet — `createTopicLink` exists and is
  tested, but is only called by the seed.
- **Mastery thresholds are hand-set.** The accuracy and attempt-count cut-offs
  are reasoned defaults, not empirically calibrated against learning outcomes.
- **Single-user local mode.** There is no login. Anyone with access to the
  machine and the database file has access to the data.
- **The seeded demo data is fictional.** First run seeds a sample IB student so
  the UI is not empty. It is labelled demo data and is not presented as any
  real person's tracked activity. Delete `studyos.db` to start clean.
- **No encryption at rest.** The SQLite file is unencrypted on disk.

## What was verified, and how

- 140 automated tests across the core and database packages, all passing
  (`pnpm test`).
- The web app was built (`next build`, TypeScript checks passing) and driven in
  a real browser: every route rendered, a flashcard was graded through the UI,
  and the resulting FSRS state change was confirmed in the database.
- Three defects found during that verification are fixed and now have
  regression tests: single-chunk allocation, never-reviewed cards reporting
  "0% recall", and completed-by-logged-time tasks reported as missing deadlines.

## What was NOT verified

- No desktop, mobile or extension build was produced or run.
- No load, performance or battery testing was done.
- No testing on low-end hardware.
- No accessibility audit with an actual screen reader. Semantic HTML, focus
  styles, `aria-current`, `aria-label`s and `prefers-reduced-motion` are in
  place, but "tested with assistive technology" would be an overstatement.
- No security review beyond the data-isolation and deletion tests.
- No multi-user or concurrent-write testing.
