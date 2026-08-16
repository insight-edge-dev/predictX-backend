-- ============================================================
-- Highlightly Data Warehouse Schema
-- Run this in Supabase SQL Editor (once).
--
-- Philosophy: Data is NEVER deleted. Every row grows the warehouse.
-- The app reads these tables first; the Highlightly API only
-- refreshes them. If the API stops tomorrow, the app keeps working.
-- ============================================================

-- ── hl_fixtures ───────────────────────────────────────────────
-- Every cricket & football match ever seen from Highlightly.
-- Upserted on id — safe to re-run with updated data.

CREATE TABLE IF NOT EXISTS hl_fixtures (
  id              TEXT PRIMARY KEY,
  league_id       TEXT        NOT NULL,
  season          INTEGER,
  format          TEXT,                       -- T20, Test, ODI, 90min, etc.
  status          TEXT        NOT NULL DEFAULT 'upcoming',  -- upcoming|live|completed
  start_date      TIMESTAMPTZ,
  home_team_id    TEXT,
  away_team_id    TEXT,
  home_team_name  TEXT,
  away_team_name  TEXT,
  home_score      TEXT,
  away_score      TEXT,
  result          TEXT,                       -- e.g. "MI won by 6 wkts"
  winner          TEXT,
  data            JSONB       NOT NULL,       -- full normalised fixture object
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hl_fixtures_league_season ON hl_fixtures (league_id, season);
CREATE INDEX IF NOT EXISTS idx_hl_fixtures_start_date    ON hl_fixtures (start_date);
CREATE INDEX IF NOT EXISTS idx_hl_fixtures_status        ON hl_fixtures (status);
CREATE INDEX IF NOT EXISTS idx_hl_fixtures_updated_at    ON hl_fixtures (updated_at DESC);

-- ── hl_scorecards ─────────────────────────────────────────────
-- Full innings-level scorecard per completed match.
-- Written once; never overwritten (permanent historical record).

CREATE TABLE IF NOT EXISTS hl_scorecards (
  match_id    TEXT PRIMARY KEY,
  data        JSONB       NOT NULL,           -- normalised scorecard (innings[])
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── hl_standings ──────────────────────────────────────────────
-- Points table snapshot per league × season.
-- Upserted on composite id = "{leagueId}:{season}".

CREATE TABLE IF NOT EXISTS hl_standings (
  id          TEXT PRIMARY KEY,               -- "{leagueId}:{season}"
  league_id   TEXT        NOT NULL,
  season      INTEGER     NOT NULL,
  data        JSONB       NOT NULL,           -- normalised standings array
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hl_standings_league ON hl_standings (league_id, season);

-- ── hl_teams ──────────────────────────────────────────────────
-- Team registry — deduplicated by Highlightly team id.
-- Upserted on id.

CREATE TABLE IF NOT EXISTS hl_teams (
  id            TEXT PRIMARY KEY,
  name          TEXT        NOT NULL,
  abbreviation  TEXT        DEFAULT '',
  logo          TEXT        DEFAULT '',
  sport         TEXT        NOT NULL DEFAULT 'cricket',
  data          JSONB       NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hl_teams_sport ON hl_teams (sport);

-- ── hl_leagues ────────────────────────────────────────────────
-- League registry — fetched from /cricket/leagues and /football/leagues.

CREATE TABLE IF NOT EXISTS hl_leagues (
  id            TEXT PRIMARY KEY,
  name          TEXT        NOT NULL,
  sport         TEXT        NOT NULL DEFAULT 'cricket',
  country_code  TEXT        DEFAULT '',
  country_name  TEXT        DEFAULT '',
  logo          TEXT        DEFAULT '',
  seasons       JSONB       DEFAULT '[]',
  data          JSONB       NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hl_leagues_sport   ON hl_leagues (sport);
CREATE INDEX IF NOT EXISTS idx_hl_leagues_country ON hl_leagues (country_code);

-- ── hl_highlights ─────────────────────────────────────────────
-- YouTube/video highlight clips. Permanent — never deleted.

CREATE TABLE IF NOT EXISTS hl_highlights (
  id          TEXT PRIMARY KEY,
  match_id    TEXT        DEFAULT '',
  league_id   TEXT        DEFAULT '',
  title       TEXT        NOT NULL DEFAULT '',
  url         TEXT        DEFAULT '',
  embed_url   TEXT        DEFAULT '',
  img_url     TEXT        DEFAULT '',
  category    TEXT        DEFAULT '',
  source      TEXT        DEFAULT '',
  data        JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hl_highlights_match  ON hl_highlights (match_id);
CREATE INDEX IF NOT EXISTS idx_hl_highlights_league ON hl_highlights (league_id);
CREATE INDEX IF NOT EXISTS idx_hl_highlights_date   ON hl_highlights (created_at DESC);

-- ── hl_players ────────────────────────────────────────────────
-- Player registry — synced from /cricket/players (and eventually /football/players).
-- Provides the player lookup needed by the prediction engine and future own-API.

CREATE TABLE IF NOT EXISTS hl_players (
  id              TEXT PRIMARY KEY,
  name            TEXT        NOT NULL,
  date_of_birth   DATE,
  nationality     TEXT        DEFAULT '',
  batting_style   TEXT        DEFAULT '',       -- "Right-hand bat", etc.
  bowling_style   TEXT        DEFAULT '',       -- "Right-arm fast-medium", etc.
  roles           JSONB       DEFAULT '[]',     -- ["Batsman","Bowler","All-rounder","Wicket-keeper"]
  image           TEXT        DEFAULT '',
  sport           TEXT        NOT NULL DEFAULT 'cricket',
  data            JSONB       NOT NULL,         -- full raw player object
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hl_players_name  ON hl_players (name);
CREATE INDEX IF NOT EXISTS idx_hl_players_sport ON hl_players (sport);

-- ── hl_player_stats ───────────────────────────────────────────
-- Per-player, per-league, per-season aggregated batting/bowling stats.
-- Derived from hl_scorecards. Enables own-API stats endpoints.

CREATE TABLE IF NOT EXISTS hl_player_stats (
  id             TEXT PRIMARY KEY,              -- "{playerId}:{leagueId}:{season}"
  player_id      TEXT        NOT NULL,
  player_name    TEXT        NOT NULL DEFAULT '',
  league_id      TEXT        NOT NULL,
  season         INTEGER     NOT NULL,
  sport          TEXT        NOT NULL DEFAULT 'cricket',
  -- Batting
  innings        INTEGER     NOT NULL DEFAULT 0,
  runs           INTEGER     NOT NULL DEFAULT 0,
  balls_faced    INTEGER     NOT NULL DEFAULT 0,
  highest_score  INTEGER     NOT NULL DEFAULT 0,
  fifties        INTEGER     NOT NULL DEFAULT 0,
  hundreds       INTEGER     NOT NULL DEFAULT 0,
  fours          INTEGER     NOT NULL DEFAULT 0,
  sixes          INTEGER     NOT NULL DEFAULT 0,
  strike_rate    NUMERIC(6,2) NOT NULL DEFAULT 0,
  average        NUMERIC(6,2) NOT NULL DEFAULT 0,
  -- Bowling
  overs_bowled   NUMERIC(6,1) NOT NULL DEFAULT 0,
  wickets        INTEGER     NOT NULL DEFAULT 0,
  runs_conceded  INTEGER     NOT NULL DEFAULT 0,
  economy        NUMERIC(6,2) NOT NULL DEFAULT 0,
  best_bowling   TEXT        DEFAULT '',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hl_pstats_player ON hl_player_stats (player_id);
CREATE INDEX IF NOT EXISTS idx_hl_pstats_league ON hl_player_stats (league_id, season);

-- ── Add sport column to hl_fixtures (if not already there) ────
-- Allows sport-based filtering without parsing JSONB data field.
ALTER TABLE hl_fixtures ADD COLUMN IF NOT EXISTS sport TEXT DEFAULT 'cricket';
CREATE INDEX IF NOT EXISTS idx_hl_fixtures_sport ON hl_fixtures (sport);

-- ============================================================
-- Verification: list table row counts after first sync.
-- Run this in Supabase SQL Editor to confirm data is flowing in:
--
--   SELECT 'hl_fixtures'     AS tbl, COUNT(*) FROM hl_fixtures
--   UNION ALL
--   SELECT 'hl_scorecards',           COUNT(*) FROM hl_scorecards
--   UNION ALL
--   SELECT 'hl_standings',            COUNT(*) FROM hl_standings
--   UNION ALL
--   SELECT 'hl_teams',                COUNT(*) FROM hl_teams
--   UNION ALL
--   SELECT 'hl_leagues',              COUNT(*) FROM hl_leagues
--   UNION ALL
--   SELECT 'hl_highlights',           COUNT(*) FROM hl_highlights
--   UNION ALL
--   SELECT 'hl_players',              COUNT(*) FROM hl_players
--   UNION ALL
--   SELECT 'hl_player_stats',         COUNT(*) FROM hl_player_stats;
-- ============================================================
