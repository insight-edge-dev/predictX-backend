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
};
