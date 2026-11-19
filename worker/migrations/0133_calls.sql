CREATE TABLE IF NOT EXISTS call_sessions (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  peer_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'direct',
  state TEXT NOT NULL DEFAULT 'ringing',
  created_at INTEGER NOT NULL,
  answered_at INTEGER NOT NULL DEFAULT 0,
  ended_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS call_sessions_peer ON call_sessions(peer_id, state, created_at);
CREATE INDEX IF NOT EXISTS call_sessions_host ON call_sessions(host_id, created_at);

CREATE TABLE IF NOT EXISTS call_invites (
  token_hash TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS call_tickets (
  token_hash TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  role TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS call_prefs (
  public_id TEXT PRIMARY KEY,
  who TEXT NOT NULL DEFAULT 'everyone',
  guests INTEGER NOT NULL DEFAULT 1,
  dnd INTEGER NOT NULL DEFAULT 0,
  dnd_start TEXT NOT NULL DEFAULT '22:00',
  dnd_end TEXT NOT NULL DEFAULT '07:00',
  tz_offset INTEGER NOT NULL DEFAULT 0,
  send_mode TEXT NOT NULL DEFAULT 'voice',
  receive_mode TEXT NOT NULL DEFAULT 'both',
  hear_original INTEGER NOT NULL DEFAULT 1,
  translation_only INTEGER NOT NULL DEFAULT 0,
  subtitles TEXT NOT NULL DEFAULT 'both',
  review_notes INTEGER NOT NULL DEFAULT 0,
  voice TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS call_guests (
  token_hash TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  guest_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
