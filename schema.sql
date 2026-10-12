-- Khazar Crypto bot üçün D1 sxemi.
-- Bu sxem worker.js-dəki SCHEMA ilə eynidir.
-- Əgər əvvəlki uyğunsuz schema.sql artıq eyni D1 bazasına icra edilibsə,
-- mövcud participants cədvəlini bu skript avtomatik dəyişməyəcək; yeni D1 bazası yaradın.

CREATE TABLE IF NOT EXISTS config (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS participants (
  user_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  invite_link TEXT,
  gen INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  adj INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_part_link ON participants(invite_link);

CREATE TABLE IF NOT EXISTS invites (
  invitee_id INTEGER PRIMARY KEY,
  inviter_id INTEGER NOT NULL,
  joined_at INTEGER,
  msg_count INTEGER NOT NULL DEFAULT 0,
  approved INTEGER NOT NULL DEFAULT 0,
  approved_at INTEGER,
  left_flag INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_inv_inviter ON invites(inviter_id);

CREATE TABLE IF NOT EXISTS msgs (
  invitee_id INTEGER NOT NULL,
  h TEXT NOT NULL,
  PRIMARY KEY (invitee_id, h)
);
