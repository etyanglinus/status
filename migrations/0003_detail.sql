-- Detailed history with response times, sized for Cloudflare D1's free plan.
-- WITHOUT ROWID tables store each row once (no extra index write), so each per-minute
-- result costs a single row write.

-- Per-check hourly buckets (EAT hour "YYYY-MM-DDTHH"), kept 8 days. `rolled` = already added to daily.
CREATE TABLE hourly (
  check_id TEXT NOT NULL,
  hour     TEXT NOT NULL,
  total    INTEGER NOT NULL DEFAULT 0,
  ok       INTEGER NOT NULL DEFAULT 0,
  degraded INTEGER NOT NULL DEFAULT 0,
  down     INTEGER NOT NULL DEFAULT 0,
  lat_sum  INTEGER NOT NULL DEFAULT 0,
  lat_max  INTEGER NOT NULL DEFAULT 0,
  rolled   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (check_id, hour)
) WITHOUT ROWID;

-- Per-check daily buckets (EAT date), kept 120 days. Filled from `hourly` once each hour completes.
CREATE TABLE daily_v2 (
  check_id TEXT NOT NULL,
  day      TEXT NOT NULL,
  total    INTEGER NOT NULL DEFAULT 0,
  ok       INTEGER NOT NULL DEFAULT 0,
  degraded INTEGER NOT NULL DEFAULT 0,
  down     INTEGER NOT NULL DEFAULT 0,
  lat_sum  INTEGER NOT NULL DEFAULT 0,
  lat_max  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (check_id, day)
) WITHOUT ROWID;
INSERT INTO daily_v2 (check_id, day, total, ok, degraded, down) SELECT check_id, day, total, ok, degraded, down FROM daily;
DROP INDEX IF EXISTS daily_day;
DROP TABLE daily;
ALTER TABLE daily_v2 RENAME TO daily;

-- Automatically detected problem periods (shown publicly as categories, never with URLs or raw errors).
CREATE TABLE outages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  check_id   TEXT NOT NULL,
  component  TEXT NOT NULL,
  severity   TEXT NOT NULL,          -- down | degraded
  kind       TEXT NOT NULL,          -- public failure category (timeout, maintenance, ...)
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
);
CREATE INDEX outages_started ON outages(started_at DESC);

