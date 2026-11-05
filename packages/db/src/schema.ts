/**
 * Schema and migrations.
 *
 * Migrations are append-only: each entry runs once, in order, inside a
 * transaction, and is recorded in `_migrations`. Never edit a shipped
 * migration — add another one — or existing installs will diverge.
 *
 * Deletion policy: user-owned rows cascade from `users`, so account deletion
 * is a single DELETE that provably removes everything. Reference rows
 * (curricula) are shared and do not cascade.
 */

export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: '001_core',
    sql: `
    CREATE TABLE users (
      id            TEXT PRIMARY KEY,
      email         TEXT UNIQUE,
      display_name  TEXT NOT NULL,
      timezone      TEXT NOT NULL DEFAULT 'UTC',
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE devices (
      id             TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label          TEXT NOT NULL,
      platform       TEXT NOT NULL,
      -- Tracking is opt-in per device and per capability. Absent row = no consent.
      tracking_scope TEXT NOT NULL DEFAULT 'manual_only',
      last_seen_at   INTEGER,
      revoked_at     INTEGER,
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX idx_devices_user ON devices(user_id);

    CREATE TABLE workspaces (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      kind       TEXT NOT NULL CHECK (kind IN ('academic','personal','project','development','research','custom')),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_workspaces_user ON workspaces(user_id);

    CREATE TABLE subjects (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
      name         TEXT NOT NULL,
      curriculum   TEXT,
      level         TEXT,
      colour       TEXT,
      archived_at  INTEGER,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX idx_subjects_user ON subjects(user_id);

    CREATE TABLE units (
      id         TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      position   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_units_subject ON units(subject_id);

    CREATE TABLE topics (
      id         TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      unit_id    TEXT REFERENCES units(id) ON DELETE SET NULL,
      name       TEXT NOT NULL,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_topics_subject ON topics(subject_id);

    -- Prerequisite edges for the knowledge graph. Self-edges are rejected.
    CREATE TABLE topic_links (
      from_topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      to_topic_id   TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      kind          TEXT NOT NULL CHECK (kind IN ('prerequisite','related')),
      PRIMARY KEY (from_topic_id, to_topic_id, kind),
      CHECK (from_topic_id <> to_topic_id)
    );

    CREATE TABLE tasks (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace_id  TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
      subject_id    TEXT REFERENCES subjects(id) ON DELETE SET NULL,
      topic_id      TEXT REFERENCES topics(id) ON DELETE SET NULL,
      title         TEXT NOT NULL,
      notes         TEXT,
      estimate_min  INTEGER NOT NULL DEFAULT 30,
      actual_min    INTEGER NOT NULL DEFAULT 0,
      due_at        INTEGER,
      priority      INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 4),
      recurrence    TEXT,
      completed_at  INTEGER,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX idx_tasks_user_due ON tasks(user_id, due_at);
    CREATE INDEX idx_tasks_user_open ON tasks(user_id, completed_at);

    CREATE TABLE task_dependencies (
      task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, depends_on),
      CHECK (task_id <> depends_on)
    );

    -- Immutable activity log. Corrections are new rows referencing the original,
    -- so the record stays auditable instead of being overwritten.
    CREATE TABLE activity_events (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id     TEXT NOT NULL,
      started_at    INTEGER NOT NULL,
      ended_at      INTEGER NOT NULL,
      active_ms     INTEGER NOT NULL DEFAULT 0,
      category      TEXT NOT NULL,
      provenance    TEXT NOT NULL CHECK (provenance IN ('measured','inferred','confirmed','demonstrated')),
      subject_id    TEXT REFERENCES subjects(id) ON DELETE SET NULL,
      topic_id      TEXT REFERENCES topics(id) ON DELETE SET NULL,
      task_id       TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      supersedes_id TEXT REFERENCES activity_events(id) ON DELETE SET NULL,
      corrected_at  INTEGER,
      note          TEXT,
      created_at    INTEGER NOT NULL,
      CHECK (ended_at > started_at),
      CHECK (active_ms >= 0 AND active_ms <= ended_at - started_at)
    );
    CREATE INDEX idx_events_user_time ON activity_events(user_id, started_at, ended_at);

    CREATE TABLE focus_sessions (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_id    TEXT REFERENCES activity_events(id) ON DELETE SET NULL,
      mode        TEXT NOT NULL,
      goal        TEXT,
      reflection  TEXT,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      interrupted INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_focus_user ON focus_sessions(user_id, started_at);

    CREATE TABLE notes (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      topic_id   TEXT REFERENCES topics(id) ON DELETE SET NULL,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_notes_user ON notes(user_id);

    CREATE TABLE note_versions (
      id         TEXT PRIMARY KEY,
      note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      body       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_note_versions ON note_versions(note_id, created_at);

    CREATE TABLE flashcards (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      topic_id   TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      front      TEXT NOT NULL,
      back       TEXT NOT NULL,
      source     TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_cards_user ON flashcards(user_id);

    -- One row per card: the card's current FSRS memory state.
    CREATE TABLE revision_states (
      card_id          TEXT PRIMARY KEY REFERENCES flashcards(id) ON DELETE CASCADE,
      stability        REAL NOT NULL,
      difficulty       REAL NOT NULL CHECK (difficulty BETWEEN 1 AND 10),
      last_reviewed_at INTEGER,
      due_at           INTEGER NOT NULL,
      reps             INTEGER NOT NULL DEFAULT 0,
      lapses           INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_revision_due ON revision_states(due_at);

    -- Append-only review log. This is what a future FSRS optimiser fits to.
    CREATE TABLE review_log (
      id             TEXT PRIMARY KEY,
      card_id        TEXT NOT NULL REFERENCES flashcards(id) ON DELETE CASCADE,
      reviewed_at    INTEGER NOT NULL,
      grade          INTEGER NOT NULL CHECK (grade BETWEEN 1 AND 4),
      elapsed_days   REAL NOT NULL,
      stability_before REAL,
      stability_after  REAL NOT NULL,
      difficulty_after REAL NOT NULL,
      interval_days  INTEGER NOT NULL,
      retrievability REAL
    );
    CREATE INDEX idx_review_log_card ON review_log(card_id, reviewed_at);

    CREATE TABLE practice_attempts (
      id             TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      topic_id       TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      question       TEXT,
      given_answer   TEXT,
      correct_answer TEXT,
      correct        INTEGER NOT NULL,
      score          REAL,
      error_category TEXT,
      attempted_at   INTEGER NOT NULL
    );
    CREATE INDEX idx_attempts_topic ON practice_attempts(topic_id, attempted_at);
    CREATE INDEX idx_attempts_user ON practice_attempts(user_id, attempted_at);

    CREATE TABLE mistakes (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      attempt_id   TEXT REFERENCES practice_attempts(id) ON DELETE SET NULL,
      topic_id     TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      summary      TEXT NOT NULL,
      explanation  TEXT,
      resolved_at  INTEGER,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX idx_mistakes_open ON mistakes(user_id, resolved_at);

    CREATE TABLE exams (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      component  TEXT,
      starts_at  INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_exams_user ON exams(user_id, starts_at);

    CREATE TABLE availability (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      starts_at  INTEGER NOT NULL,
      ends_at    INTEGER NOT NULL,
      fixed      INTEGER NOT NULL DEFAULT 0,
      label      TEXT,
      CHECK (ends_at > starts_at)
    );
    CREATE INDEX idx_availability_user ON availability(user_id, starts_at);

    CREATE TABLE daily_reports (
      id        TEXT PRIMARY KEY,
      user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date      TEXT NOT NULL,
      payload   TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (user_id, date)
    );

    -- Durable mutation queue for offline clients. Idempotent on (device, seq).
    CREATE TABLE sync_queue (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id   TEXT NOT NULL,
      seq         INTEGER NOT NULL,
      entity      TEXT NOT NULL,
      op          TEXT NOT NULL CHECK (op IN ('upsert','delete')),
      payload     TEXT NOT NULL,
      queued_at   INTEGER NOT NULL,
      applied_at  INTEGER,
      error       TEXT,
      UNIQUE (device_id, seq)
    );
    CREATE INDEX idx_sync_pending ON sync_queue(user_id, applied_at);

    CREATE TABLE audit_log (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action     TEXT NOT NULL,
      detail     TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_audit_user ON audit_log(user_id, created_at);
    `,
  },
  {
    id: '002_fts_notes',
    sql: `
    -- Full-text search over notes. Kept in sync by triggers so search can
    -- never silently drift from the notes table.
    CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, content='notes', content_rowid='rowid');

    CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
    END;
    CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
    END;
    CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
      INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
    END;
    `,
  },
  {
    id: '003_user_fsrs_params',
    sql: `
    -- Per-user FSRS weights, so a future optimiser can fit each user's log
    -- without a schema change. NULL means "use the published defaults".
    CREATE TABLE revision_params (
      user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      weights_json      TEXT,
      desired_retention REAL NOT NULL DEFAULT 0.9,
      maximum_interval  INTEGER NOT NULL DEFAULT 36500,
      updated_at        INTEGER NOT NULL
    );
    `,
  },
];
