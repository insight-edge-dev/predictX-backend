/**
 * dbService.js — Supabase persistent cache layer.
 *
 * Strategy:
 *   Controllers call DB before hitting CricketData API.
 *   On API fetch, result is written back to DB for future requests.
 *
 * Rules:
 *   - Players / Series / Squads → stored forever (static data)
 *   - Completed matches         → stored forever
 *   - Live / upcoming matches   → NodeCache only, never written here
 *   - All functions catch their own errors and return null on failure
 *     so a DB outage never crashes the app.
 *
 * ─────────────────────────────────────────────────────────────────
 * SUPABASE TABLE DDL — run once in the Supabase SQL Editor:
 *
 *   create table if not exists series (
 *     id          text        primary key,
 *     data        jsonb       not null,
 *     updated_at  timestamptz not null default now()
 *   );
 *
 *   create table if not exists matches (
 *     id          text        primary key,
 *     status      text        not null,
 *     data        jsonb       not null,
 *     updated_at  timestamptz not null default now()
 *   );
 *
 *   create table if not exists players (
 *     id          text        primary key,
 *     data        jsonb       not null,
 *     updated_at  timestamptz not null default now()
 *   );
 *
 *   create table if not exists squads (
 *     match_id    text        primary key,
 *     data        jsonb       not null,
 *     updated_at  timestamptz not null default now()
 *   );
 *
 *   -- Permanent reference data — upserted whenever the API returns
 *   -- fresh data (not TTL-expired; rows persist and are kept current).
 *
 *   create table if not exists cricket_teams (
 *     id          text        primary key,
 *     data        jsonb       not null,
 *     updated_at  timestamptz not null default now()
 *   );
 *
 *   create table if not exists cricket_venues (
 *     id          text        primary key,
 *     data        jsonb       not null,
 *     updated_at  timestamptz not null default now()
 *   );
 *
 *   create table if not exists football_teams (
 *     code        text        primary key,
 *     data        jsonb       not null,
 *     updated_at  timestamptz not null default now()
 *   );
 *
 *   create table if not exists football_fixtures (
 *     id          text        primary key,
 *     status      text        not null,
 *     data        jsonb       not null,
 *     updated_at  timestamptz not null default now()
 *   );
 *
 *   create table if not exists football_groups (
 *     group_name  text        primary key,
 *     data        jsonb       not null,
 *     updated_at  timestamptz not null default now()
 *   );
 * ─────────────────────────────────────────────────────────────────
 */

const supabase = require("../config/supabase");

const NOW = () => new Date().toISOString();

// ── Internal helpers ──────────────────────────────────────────

/**
 * Reads a single row's `data` column from `table` where `column = value`.
 * Returns the parsed object, or null on miss / error.
 */
async function _fetchOne(table, column, value) {
  try {
    const { data, error } = await supabase
      .from(table)
      .select("data")
      .eq(column, value)
      .single();

    if (error || !data) return null;
    return data.data;
  } catch (e) {
    console.warn(`[DB] ${table}.get(${value}) failed:`, e.message);
    return null;
  }
}

/**
 * Upserts a row into `table`.
 * `row` must be a plain object matching the table schema.
 * `conflictCol` is the column used for conflict detection.
 */
async function _upsert(table, row, conflictCol) {
  try {
    const { error } = await supabase
      .from(table)
      .upsert(row, { onConflict: conflictCol });

    if (error) console.warn(`[DB] ${table}.upsert failed:`, error.message);
  } catch (e) {
    console.warn(`[DB] ${table}.upsert error:`, e.message);
  }
}

// ── Series ────────────────────────────────────────────────────
// Stores the full series info payload: { series, matches, table }

async function getSeries(id) {
  const result = await _fetchOne("series", "id", id);
  if (result) console.log(`[DB] series hit for ${id}`);
  return result;
}

async function saveSeries(id, payload) {
  await _upsert("series", { id, data: payload, updated_at: NOW() }, "id");
  console.log(`[DB] series saved: ${id}`);
}

// ── Matches ───────────────────────────────────────────────────
// Stores normalized match detail. Only completed matches should be saved.

async function getMatch(id) {
  const result = await _fetchOne("matches", "id", id);
  if (result) console.log(`[DB] match hit for ${id}`);
  return result;
}

async function saveMatch(id, status, data) {
  await _upsert("matches", { id, status, data, updated_at: NOW() }, "id");
  console.log(`[DB] match saved: ${id} (${status})`);
}

// ── Players ───────────────────────────────────────────────────
// Stores full normalized player profile from /players_info.

async function getPlayer(id) {
  const result = await _fetchOne("players", "id", id);
  if (result) console.log(`[DB] player hit for ${id}`);
  return result;
}

async function savePlayer(id, data) {
  await _upsert("players", { id, data, updated_at: NOW() }, "id");
  console.log(`[DB] player saved: ${id}`);
}

// ── Squads ────────────────────────────────────────────────────
// Stores normalized squad by match ID. Squad data never changes post-match.

async function getSquad(matchId) {
  const result = await _fetchOne("squads", "match_id", matchId);
  if (result) console.log(`[DB] squad hit for match ${matchId}`);
  return result;
}

async function saveSquad(matchId, data) {
  await _upsert("squads", { match_id: matchId, data, updated_at: NOW() }, "match_id");
  console.log(`[DB] squad saved for match: ${matchId}`);
}

// ── Fixtures (IPL schedule — stored once per day) ─────────────
// Uses the `series` table with a synthetic key (e.g. "ipl:fixtures:2026").
// Returns null if the row doesn't exist or is older than 24 h.

const DAILY_MS = 24 * 60 * 60 * 1000;

async function getFixtures(key) {
  try {
    const { data, error } = await supabase
      .from("series")
      .select("data, updated_at")
      .eq("id", key)
      .single();

    if (error || !data) return null;

    const age = Date.now() - new Date(data.updated_at).getTime();
    if (age > DAILY_MS) {
      console.log(`[DB] CACHE SKIP fixtures:${key} — stale (${Math.round(age / 3_600_000)}h old)`);
      return null;
    }

    console.log(`[DB] CACHE HIT fixtures:${key}`);
    return data.data;
  } catch (e) {
    console.warn(`[DB] getFixtures(${key}) failed:`, e.message);
    return null;
  }
}

async function saveFixtures(key, data) {
  await _upsert("series", { id: key, data, updated_at: NOW() }, "id");
  console.log(`[DB] fixtures saved: ${key}`);
}

async function deleteFixtures(key) {
  try {
    const { error } = await supabase.from("series").delete().eq("id", key);
    if (error) console.warn(`[DB] deleteFixtures(${key}) failed:`, error.message);
    else console.log(`[DB] fixtures deleted: ${key}`);
  } catch (e) {
    console.warn(`[DB] deleteFixtures(${key}) error:`, e.message);
  }
}

// ── Cricket reference data (teams / venues) ──────────────────
// Permanent rows, upserted whenever fresh fixtures arrive from the API
// so each team/venue stays current without ever expiring.

async function getCricketTeam(id) {
  return _fetchOne("cricket_teams", "id", id);
}

async function saveCricketTeam(id, data) {
  await _upsert("cricket_teams", { id, data, updated_at: NOW() }, "id");
}

async function getCricketVenue(id) {
  return _fetchOne("cricket_venues", "id", id);
}

async function saveCricketVenue(id, data) {
  await _upsert("cricket_venues", { id, data, updated_at: NOW() }, "id");
}

/**
 * Extracts unique teams and venues from a list of normalized cricket
 * fixtures (sportmonksNormalizer output: { team1, team2, venue, venueId })
 * and upserts them. Fire-and-forget — call as `void db.syncCricketReferenceData(fixtures)`.
 */
async function syncCricketReferenceData(fixtures) {
  if (!Array.isArray(fixtures) || fixtures.length === 0) return;

  const teams  = new Map();
  const venues = new Map();

  for (const f of fixtures) {
    for (const team of [f.team1, f.team2]) {
      if (team?.id) teams.set(String(team.id), team);
    }
    if (f.venueId) venues.set(f.venueId, { id: f.venueId, name: f.venue || "" });
  }

  for (const [id, data] of teams)  await saveCricketTeam(id, data);
  for (const [id, data] of venues) await saveCricketVenue(id, data);

  if (teams.size || venues.size) {
    console.log(`[DB] cricket reference sync — ${teams.size} teams, ${venues.size} venues`);
  }
}

// ── Football reference data (teams / fixtures / groups) ──────
// Permanent rows, upserted whenever fresh data arrives from the API
// so the WC schedule and standings stay current without ever expiring.

async function getFootballTeam(code) {
  return _fetchOne("football_teams", "code", code);
}

async function saveFootballTeam(code, data) {
  await _upsert("football_teams", { code, data, updated_at: NOW() }, "code");
}

async function getFootballFixture(id) {
  return _fetchOne("football_fixtures", "id", id);
}

async function saveFootballFixture(id, status, data) {
  await _upsert("football_fixtures", { id, status, data, updated_at: NOW() }, "id");
}

async function getFootballGroup(groupName) {
  return _fetchOne("football_groups", "group_name", groupName);
}

async function saveFootballGroup(groupName, data) {
  await _upsert("football_groups", { group_name: groupName, data, updated_at: NOW() }, "group_name");
}

/**
 * Upserts every fixture (and the teams it references) from a freshly
 * fetched WC fixture list. Fire-and-forget — call as `void db.syncFootballFixtures(fixtures)`.
 */
async function syncFootballFixtures(fixtures) {
  if (!Array.isArray(fixtures) || fixtures.length === 0) return;

  const teams = new Map();
  for (const f of fixtures) {
    await saveFootballFixture(f.id, f.status, f);
    for (const team of [f.homeTeam, f.awayTeam]) {
      if (team?.id) teams.set(team.id, team);
    }
  }
  for (const [id, data] of teams) await saveFootballTeam(id, data);

  console.log(`[DB] football fixture sync — ${fixtures.length} fixtures, ${teams.size} teams`);
}

/**
 * Upserts every group's standings (and the teams within them) from a
 * freshly fetched WC standings response. Fire-and-forget.
 */
async function syncFootballGroups(groups) {
  const entries = Object.entries(groups || {});
  if (entries.length === 0) return;

  const teams = new Map();
  for (const [groupName, rows] of entries) {
    await saveFootballGroup(groupName, rows);
    for (const row of rows) {
      if (row.team?.id) teams.set(row.team.id, row.team);
    }
  }
  for (const [id, data] of teams) await saveFootballTeam(id, data);

  console.log(`[DB] football group sync — ${entries.length} groups, ${teams.size} teams`);
}

// ── Generic keyed cache (uses `series` table) ─────────────────
// Used for rankings, news, and any other external API data.
// TTL is enforced server-side by checking `updated_at`.

async function getCachedData(key, ttlMs) {
  try {
    const { data, error } = await supabase
      .from("series")
      .select("data, updated_at")
      .eq("id", key)
      .single();

    if (error || !data) return null;

    const age = Date.now() - new Date(data.updated_at).getTime();
    if (age > ttlMs) {
      console.log(`[DB] CACHE STALE ${key} — ${Math.round(age / 60_000)}m old`);
      return null;
    }

    console.log(`[DB] CACHE HIT ${key} — ${Math.round(age / 60_000)}m old`);
    return data.data;
  } catch (e) {
    console.warn(`[DB] getCachedData(${key}) failed:`, e.message);
    return null;
  }
}

async function setCachedData(key, payload) {
  await _upsert("series", { id: key, data: payload, updated_at: NOW() }, "id");
  console.log(`[DB] CACHE SET ${key}`);
}

// ── Bulk delete helpers (admin / reset) ──────────────────────

async function deleteAllMatches() {
  try {
    const { error } = await supabase.from("matches").delete().not("id", "is", null);
    if (error) console.warn("[DB] deleteAllMatches failed:", error.message);
    else console.log("[DB] all matches deleted");
  } catch (e) {
    console.warn("[DB] deleteAllMatches error:", e.message);
  }
}

async function deleteAllSquads() {
  try {
    const { error } = await supabase.from("squads").delete().not("match_id", "is", null);
    if (error) console.warn("[DB] deleteAllSquads failed:", error.message);
    else console.log("[DB] all squads deleted");
  } catch (e) {
    console.warn("[DB] deleteAllSquads error:", e.message);
  }
}

/** Delete all rows in the `series` table whose id starts with prefix. */
async function deleteCachedByPrefix(prefix) {
  try {
    const { error } = await supabase
      .from("series")
      .delete()
      .like("id", `${prefix}%`);
    if (error) console.warn(`[DB] deleteCachedByPrefix(${prefix}) failed:`, error.message);
    else console.log(`[DB] deleted all cache keys with prefix: ${prefix}`);
  } catch (e) {
    console.warn(`[DB] deleteCachedByPrefix(${prefix}) error:`, e.message);
  }
}

module.exports = {
  getSeries,
  saveSeries,
  getMatch,
  saveMatch,
  getPlayer,
  savePlayer,
  getSquad,
  saveSquad,
  getFixtures,
  saveFixtures,
  deleteFixtures,
  getCachedData,
  setCachedData,
  deleteAllMatches,
  deleteAllSquads,
  deleteCachedByPrefix,
  getCricketTeam,
  saveCricketTeam,
  getCricketVenue,
  saveCricketVenue,
  syncCricketReferenceData,
  getFootballTeam,
  saveFootballTeam,
  getFootballFixture,
  saveFootballFixture,
  getFootballGroup,
  saveFootballGroup,
  syncFootballFixtures,
  syncFootballGroups,
};
