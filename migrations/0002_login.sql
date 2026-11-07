-- Built-in operator login: failed-attempt tracking for rate limiting.
CREATE TABLE login_attempts (
  key        TEXT NOT NULL,          -- "ip:<address>"
  at         INTEGER NOT NULL
);
CREATE INDEX login_attempts_key_at ON login_attempts(key, at);
