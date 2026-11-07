-- Fasta Status schema (Cloudflare D1 / SQLite). All timestamps are Unix ms (UTC);
-- the UI renders them in East Africa Time.

-- Latest state of each automated check (one row per check id).
CREATE TABLE check_state (
  check_id        TEXT PRIMARY KEY,
  state           TEXT NOT NULL DEFAULT 'up',      -- up | degraded | down (after thresholds)
  fail_streak     INTEGER NOT NULL DEFAULT 0,
  slow_streak     INTEGER NOT NULL DEFAULT 0,
  ok_streak       INTEGER NOT NULL DEFAULT 0,
  up_streak       INTEGER NOT NULL DEFAULT 0,
  first_failure_at INTEGER,
  down_since      INTEGER,
  last_outcome    TEXT,
  last_reason     TEXT,                            -- private: never sent to the public API
  last_status     INTEGER,
  last_latency_ms INTEGER,
  last_result_at  INTEGER
);

-- Daily rollup per check, keyed by EAT calendar date (YYYY-MM-DD).
CREATE TABLE daily (
  check_id TEXT NOT NULL,
  day      TEXT NOT NULL,
  total    INTEGER NOT NULL DEFAULT 0,
  ok       INTEGER NOT NULL DEFAULT 0,
  degraded INTEGER NOT NULL DEFAULT 0,
  down     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (check_id, day)
);

-- Private event log for the operator dashboard (alerts, recoveries).
CREATE TABLE check_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  check_id  TEXT NOT NULL,
  kind      TEXT NOT NULL,          -- down | degraded | recovered
  reason    TEXT,
  at        INTEGER NOT NULL,
  alerted   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX check_events_at ON check_events(at DESC);

CREATE TABLE incidents (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  stage          TEXT NOT NULL,      -- investigating | identified | monitoring | resolved
  impact         TEXT NOT NULL,      -- degraded | partial_outage | major_outage
  components     TEXT NOT NULL,      -- JSON array of component ids
  started_at     INTEGER NOT NULL,
  resolved_at    INTEGER,
  next_update_at INTEGER,
  created_by     TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX incidents_started ON incidents(started_at DESC);

CREATE TABLE incident_updates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id    INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  stage          TEXT NOT NULL,
  message        TEXT NOT NULL,
  next_update_at INTEGER,
  created_by     TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX incident_updates_incident ON incident_updates(incident_id, created_at);

CREATE TABLE maintenance (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  message     TEXT NOT NULL,         -- expected customer impact
  components  TEXT NOT NULL,
  starts_at   INTEGER NOT NULL,
  ends_at     INTEGER NOT NULL,
  cancelled   INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX maintenance_starts ON maintenance(starts_at DESC);

CREATE TABLE changelog (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  category     TEXT NOT NULL,        -- new | improved | fixed
  audience     TEXT NOT NULL DEFAULT 'everyone', -- everyone | customers | sellers | riders
  published_at INTEGER NOT NULL,
  draft        INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX changelog_published ON changelog(published_at DESC);

CREATE TABLE roadmap (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  stage       TEXT NOT NULL,         -- planned | in_progress | beta | shipped
  audience    TEXT NOT NULL DEFAULT 'everyone',
  eta_label   TEXT,                  -- free text such as "Early 2027" (no hard promises)
  sort_order  INTEGER NOT NULL DEFAULT 0,
  hidden      INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Small key/value store: last_run_at, and the prebuilt public snapshot.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX daily_day ON daily(day);
