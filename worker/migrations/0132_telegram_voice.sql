-- Voice-note chats, one list per bot. The bot token is never stored.
-- Message text is not stored. A dedicated voice bot and the main bot
-- do not share rows.
CREATE TABLE IF NOT EXISTS telegram_voice_chats (
  bot_scope TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  unavailable INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER NOT NULL DEFAULT 0,
  owner_chat INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bot_scope, chat_id)
);

CREATE TABLE IF NOT EXISTS telegram_voice_state (
  bot_scope TEXT PRIMARY KEY,
  update_offset INTEGER NOT NULL DEFAULT 0,
  bot_username TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS telegram_voice_invites (
  bot_scope TEXT NOT NULL,
  code TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  self INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  used_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bot_scope, code)
);
