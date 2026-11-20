CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  tz TEXT NOT NULL DEFAULT 'Europe/Berlin',
  weekly_hours REAL NOT NULL DEFAULT 40,
  work_days TEXT NOT NULL DEFAULT '1,2,3,4,5',   -- 0=Sun .. 6=Sat
  start_date TEXT NOT NULL,                      -- balance is counted from this local date
  initial_balance_min INTEGER NOT NULL DEFAULT 0,
  cal_token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_s INTEGER NOT NULL,                      -- epoch seconds (UTC)
  end_s INTEGER,                                 -- NULL = timer running
  note TEXT NOT NULL DEFAULT '',
  extra_break_s INTEGER NOT NULL DEFAULT 0,      -- break time for manual entries
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_entries_user_start ON entries(user_id, start_s);
-- at most one running timer per user
CREATE UNIQUE INDEX one_running_entry ON entries(user_id) WHERE end_s IS NULL;

CREATE TABLE breaks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  start_s INTEGER NOT NULL,
  end_s INTEGER                                  -- NULL = break in progress
);
CREATE INDEX idx_breaks_entry ON breaks(entry_id);
CREATE UNIQUE INDEX one_open_break ON breaks(entry_id) WHERE end_s IS NULL;
