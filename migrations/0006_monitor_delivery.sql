CREATE TABLE IF NOT EXISTS monitor_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alert_outbox (
  event_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS alert_outbox_pending ON alert_outbox(sent_at, created_at);
