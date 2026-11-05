# Platform capability matrix

What this build actually does, per platform. Anything not marked **Built** is
not in this repository. Nothing below is inferred from documentation — the
"Built" column means the code exists here and is covered by tests or verified
in a browser.

## Legend

- **Built** — implemented in this repo and verified.
- **Not built** — not implemented. No stub, no mock, no placeholder UI.
- **Blocked** — cannot be implemented in this environment; the blocker is named.

## Platforms

| Platform | Status | Notes |
|---|---|---|
| Web (Next.js) | **Built** | 7 routes, server-rendered, runs offline against local SQLite. Verified in a browser. |
| macOS desktop (Tauri) | **Blocked** | Tauri requires a Rust toolchain. This machine has no Rust and no Homebrew, and installing one was out of scope. The shared UI and domain packages are deliberately framework-agnostic so a Tauri or Electron shell can wrap them later. |
| Windows desktop | **Blocked** | Same Rust dependency; also no Windows machine available to verify a build. |
| iOS / Android (React Native) | **Not built** | Would need Expo plus a native build; no device or simulator verification was possible here, and shipping an unverified mobile build would violate the "do not claim unverified builds" rule. |
| Browser extension | **Not built** | The activity-event schema and ingest path (`recordEvent`) are extension-ready: an extension would post `ActivityEvent` rows with `provenance: 'measured'`. The extension itself does not exist. |
| Menu-bar / tray timer | **Not built** | Depends on the desktop shell above. |
| Mobile widgets | **Not built** | Depends on the mobile app above. |

## Tracking capabilities

| Capability | Status | Notes |
|---|---|---|
| Manual study sessions | **Built** | Focus timer writes a real `ActivityEvent` with `provenance: 'confirmed'`. |
| Focus session tracking | **Built** | Elapsed and active time tracked separately; pauses reduce active time only. |
| Idle / pause handling | **Built** | Paused milliseconds are excluded from active time, never from elapsed. |
| Multi-device overlap handling | **Built** | Union-based aggregation; three devices reporting one hour yields one hour. Tested. |
| Device-switch timeline | **Built** | `reconstructTimeline` merges contiguous runs and records every contributing device. |
| Session editing / correction | **Built** | Corrections are new superseding rows; originals are retained and audit-logged. |
| Overlap detection and reporting | **Built** | Conflicts are counted, surfaced in the UI, and downgrade affected figures to `inferred`. |
| Offline session entry | **Built** | Any session can be entered after the fact; the app needs no network at all. |
| Desktop app usage tracking | **Not built** | Requires the desktop shell and macOS Accessibility / Screen Time permissions. |
| Browser activity tracking | **Not built** | Requires the extension. |
| Android usage tracking | **Not built** | Would use `UsageStatsManager` behind the `PACKAGE_USAGE_STATS` special permission. |
| iOS usage tracking | **Not built** | Would require the Family Controls / `DeviceActivity` entitlement, which Apple grants by application and which cannot be self-certified here. **An honest fallback (manual and in-app sessions) is what this build ships.** |

## Learning and AI capabilities

| Capability | Status | Notes |
|---|---|---|
| FSRS-4.5 spaced repetition | **Built** | Full implementation with the published default weights. Mathematical invariants tested. |
| Review log for future optimisation | **Built** | Every review appends stability/difficulty/retrievability — the input an FSRS optimiser needs. |
| Forgetfulness radar | **Built** | Per-topic decay ranking with stated evidence. |
| Mistake notebook | **Built** | Wrong answers open entries automatically and flag the topic in the review queue. |
| Mastery from evidence | **Built** | Derived from graded performance and retention only; study duration is structurally excluded. |
| Deterministic planner | **Built** | Dependency-aware, deadline-aware, reports infeasibility instead of hiding it. |
| What-if scenarios | **Built** | Re-runs the planner under altered assumptions. |
| Daily intelligence report | **Built** | Assembled from records; every figure carries provenance. |
| Knowledge graph | **Built** | Interactive SVG graph with deterministic layering, search, mastery filters, click-to-focus neighbourhood dimming, and a relations panel. |
| Weak-prerequisite detection | **Built** | Reports a foundation gap only when the dependent topic *and* a prerequisite are both unsolid, so it never sends the user to revise the wrong thing. |
| Ready-to-learn detection | **Built** | Not-yet-started topics whose prerequisites are all solid. |
| AI tutor | **Not built** | Requires a paid model API. See `docs/limitations.md` — this was a deliberate refusal, not an oversight. |
| Master Notes / document ingestion | **Partial** | Notes with versioning and full-text search are built. PDF/DOCX parsing and RAG are not. |
| AI oral examiner | **Not built** | Requires speech and model APIs. |
| Specialised AI agents | **Not built** | Same reason. |

## Infrastructure

| Capability | Status | Notes |
|---|---|---|
| Database + migrations | **Built** | `node:sqlite`, 24 tables, append-only migrations, foreign keys enforced. |
| Data export | **Built** | Complete JSON export of every user-owned table. |
| Account deletion | **Built** | Single cascading delete, verified by a test that asserts zero residual rows. |
| Per-user data isolation | **Built** | Every query is user-scoped; tested across every list endpoint. |
| Offline mutation queue | **Built** | Idempotent on `(device_id, seq)`; replays are no-ops. |
| Authentication | **Not built** | Local single-user mode. The schema is multi-user and every query is already scoped, so auth is an addition rather than a rewrite. |
| Cross-device sync transport | **Partial** | The durable queue and conflict-safe schema exist; there is no sync server. |
| Supabase / Postgres backend | **Not built** | Replaced with local SQLite. See `docs/limitations.md`. |
| Push notifications / email | **Not built** | Both require paid or credentialed services. |
| Collaboration / study groups | **Not built** | Out of scope for this pass. |
| Billing and subscription tiers | **Not built** | Out of scope for this pass. |
