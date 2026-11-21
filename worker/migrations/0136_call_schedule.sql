-- Scheduled call invites created from inside the app. A guest token
-- (cs1.) lets someone without an account join when the call is due.
-- Reminders fire 15 minutes before and at the start.

CREATE TABLE IF NOT EXISTS call_schedules (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  peer_id TEXT NOT NULL DEFAULT '',
  guest_token TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 30,
  title TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  host_rsvp TEXT NOT NULL DEFAULT 'yes',
  peer_rsvp TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'scheduled',
  reminded_15 INTEGER NOT NULL DEFAULT 0,
  reminded_start INTEGER NOT NULL DEFAULT 0,
  call_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_schedules_token ON call_schedules(token_hash);
CREATE INDEX IF NOT EXISTS idx_call_schedules_host ON call_schedules(host_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_call_schedules_peer ON call_schedules(peer_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_call_schedules_due ON call_schedules(state, starts_at);
