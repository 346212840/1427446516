CREATE TABLE IF NOT EXISTS call_turn (
  call_id TEXT PRIMARY KEY,
  month TEXT NOT NULL,
  reserved INTEGER NOT NULL,
  issued INTEGER NOT NULL DEFAULT 1,
  settled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS call_turn_month ON call_turn (month);
