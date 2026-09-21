-- Migration 0001: tweets, participants, labels.
-- Applied with `npm run db:migrate`; never destructive.

-- The task dataset: 60 tweets from the Emotion dataset (10 per category).
CREATE TABLE IF NOT EXISTS tweets (
  id         INTEGER PRIMARY KEY,
  text       TEXT NOT NULL,
  gold_label TEXT NOT NULL
);

-- One row per person who starts the task.
CREATE TABLE IF NOT EXISTS participants (
  id           TEXT PRIMARY KEY,   -- server-generated UUID
  display_name TEXT,               -- self-reported identifier (uniqname, "GSI", ...)
  user_agent   TEXT,
  assigned_ids TEXT NOT NULL,       -- JSON array of the 5 tweet ids sampled for this person
  started_at   TEXT NOT NULL,
  completed_at TEXT
);

-- One row per (participant, tweet) labeling decision.
CREATE TABLE IF NOT EXISTS labels (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id TEXT NOT NULL REFERENCES participants(id),
  tweet_id       INTEGER NOT NULL REFERENCES tweets(id),
  chosen_label   TEXT NOT NULL,
  gold_label     TEXT NOT NULL,
  is_correct     INTEGER NOT NULL,   -- 1 if chosen == gold
  position       INTEGER NOT NULL,   -- 1..5, order shown to this participant
  dwell_ms       INTEGER,            -- time on this tweet before answering
  created_at     TEXT NOT NULL,
  UNIQUE (participant_id, tweet_id)
);

CREATE INDEX IF NOT EXISTS idx_labels_participant ON labels (participant_id);
CREATE INDEX IF NOT EXISTS idx_labels_tweet       ON labels (tweet_id);
