CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings(key, value) VALUES
  ('active', '1'),
  ('started_at', '0'),
  ('ends_at', '0'),
  ('duration_days', '30'),
  ('month_label', 'Oktyabr'),
  ('interval_hours', '24'),
  ('next_leaderboard_at', '0'),
  ('awaiting_winners', '0'),
  ('custom_end_at', '0');

CREATE TABLE IF NOT EXISTS participants (
  user_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL DEFAULT 0 CHECK(score >= 0),
  is_member INTEGER NOT NULL DEFAULT 1 CHECK(is_member IN (0, 1)),
  disqualified INTEGER NOT NULL DEFAULT 0 CHECK(disqualified IN (0, 1)),
  invite_link TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_participants_leaderboard
  ON participants(is_member, disqualified, score DESC);

CREATE TABLE IF NOT EXISTS invite_links (
  link TEXT PRIMARY KEY,
  inviter_id INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invite_links_owner
  ON invite_links(inviter_id);

CREATE TABLE IF NOT EXISTS referrals (
  invitee_id INTEGER PRIMARY KEY,
  inviter_id INTEGER NOT NULL,
  qualified_messages INTEGER NOT NULL DEFAULT 0 CHECK(qualified_messages >= 0),
  credited INTEGER NOT NULL DEFAULT 0 CHECK(credited IN (0, 1)),
  is_member INTEGER NOT NULL DEFAULT 1 CHECK(is_member IN (0, 1)),
  eligible INTEGER NOT NULL DEFAULT 1 CHECK(eligible IN (0, 1)),
  joined_at INTEGER NOT NULL,
  left_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_referrals_inviter
  ON referrals(inviter_id, credited, eligible, is_member);

CREATE TABLE IF NOT EXISTS message_counts (
  invitee_id INTEGER NOT NULL,
  message_hash TEXT NOT NULL,
  PRIMARY KEY(invitee_id, message_hash)
);

CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER PRIMARY KEY
);
