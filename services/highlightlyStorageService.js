/**
 * highlightlyStorageService.js — Permanent data warehouse layer.
 *
 * Philosophy:
 *   Data fetched from Highlightly is NEVER discarded. Every fixture,
 *   scorecard, standings snapshot, team, and highlight is upserted into
 *   dedicated Supabase tables and stays there forever.
 *
 *   The app reads from these tables first. The API is only called when
 *   the stored data is stale (> 6 h for fixtures) or missing. If the
 *   API goes down, the app continues serving from the warehouse
 *   indefinitely — no expiry, no empty screens.
 *
 * Tables (run highlightly_schema.sql in Supabase SQL Editor):
 *   hl_fixtures   — every match ever seen
 *   hl_scorecards — full innings detail per completed match
 *   hl_standings  — standings snapshot per league+season
 *   hl_teams      — team registry
 *   hl_leagues    — league registry
 *   hl_highlights — YouTube highlight clips
 *
 * All functions swallow their own errors and return safe empty defaults
 * so a DB outage never crashes the app.
 */

const supabase      = require("../config/supabase");
const { dbWriteQueue } = require("./dbWriteQueue");

const NOW = () => new Date().toISOString();

// ── Internal helpers ──────────────────────────────────────────
// _upsert is a raw helper — NOT queue-wrapped. Only call it inside
// a dbWriteQueue.enqueue() callback to avoid re-entrancy deadlock.

async function _upsert(table, rows, conflict = "id") {
  if (!rows?.length) return;
  const { error } = await supabase.from(table).upsert(rows, { onConflict: conflict });
  if (error) console.error(`[HL Storage] ${table} upsert failed:`, error.message);
}

// ── Fixtures ──────────────────────────────────────────────────

/**
 * Permanently store normalized fixture objects.
 * Upserts on id — safe to call repeatedly with the same data.
 */
const UPSERT_CHUNK = 50; // max rows per Supabase upsert call — prevents timeouts on large batches

async function storeFixtures(fixtures, priority = 'normal') {
  if (!fixtures?.length) return;
  return dbWriteQueue.enqueue(async () => {
    const rows = fixtures.map(f => ({
      id:             f.id,
      league_id:      String(f.leagueId || ""),
      season:         f.season ? Number(f.season) : null,
      format:         f.format   || null,
      status:         f.status   || "upcoming",
      start_date:     f.date     || null,
      home_team_id:   f.team1?.id   || null,
      away_team_id:   f.team2?.id   || null,
      home_team_name: f.team1?.name || null,
      away_team_name: f.team2?.name || null,
      home_score:     f.score1   || null,
      away_score:     f.score2   || null,
      result:         f.statusText || null,
      winner:         f.winner   || null,
      data:           f,
      updated_at:     NOW(),
    }));

    // Chunked upsert — prevents single large call from timing out (historical syncs can be 100+ rows)
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      await _upsert("hl_fixtures", rows.slice(i, i + UPSERT_CHUNK), "id");
    }
    console.log(`[HL Storage] stored ${rows.length} fixtures`);

    // Capture league logos from fixture data (both upserts in one queue slot)
    const leagueMap = new Map();
    for (const f of fixtures) {
      const id = String(f.leagueId || "");
      if (!id || leagueMap.has(id)) continue;
      leagueMap.set(id, {
        id,
        name:       f.leagueName || "",
        logo:       f.leagueLogo || "",
        sport:      f.sport || "cricket",
        data:       { id, name: f.leagueName || "", sport: f.sport || "cricket" },
        updated_at: NOW(),
      });
    }
    const leagueRows = [...leagueMap.values()].filter(l => l.logo);
    if (leagueRows.length) await _upsert("hl_leagues", leagueRows, "id");
  }, priority);
}

/**
 * Fetch stored fixtures for a league season.
 * Returns { fixtures[], updatedAt, count }.
 * Never returns stale vs. fresh — that's the caller's concern.
 */
async function getFixtures(leagueId, season) {
  try {
    const { data, error } = await supabase
      .from("hl_fixtures")
      .select("data, updated_at")
      .eq("league_id", String(leagueId))
      .eq("season", Number(season))
      .order("start_date", { ascending: true });

    if (error) throw error;
    return {
      fixtures:  (data || []).map(r => r.data),
      updatedAt: data?.[0]?.updated_at ?? null,
      count:     data?.length ?? 0,
    };
  } catch (e) {
    console.error("[HL Storage] getFixtures failed:", e.message);
    return { fixtures: [], updatedAt: null, count: 0 };
  }
}

/**
 * Fetch stored fixtures within a rolling ±N-day window (no season filter).
 * Used by the serving path so cross-season data (e.g. La Liga 2025/26 results +
 * La Liga 2026/27 upcoming) is returned in a single query.
 */
async function getFixturesByWindow(leagueId, daysBefore = 180, daysAhead = 180) {
  try {
    const from = new Date(Date.now() - daysBefore * 86_400_000).toISOString().slice(0, 10);
    const to   = new Date(Date.now() + daysAhead  * 86_400_000).toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from("hl_fixtures")
      .select("data, updated_at")
      .eq("league_id", String(leagueId))
      .gte("start_date", `${from}T00:00:00.000Z`)
      .lte("start_date", `${to}T23:59:59.999Z`)
      .order("start_date", { ascending: true });

    if (error) throw error;
    // Use most-recently updated row for staleness check (not the first/oldest row)
    const mostRecentUpdate = data?.length
      ? data.reduce((max, r) => (r.updated_at > max ? r.updated_at : max), data[0].updated_at)
      : null;
    return {
      fixtures:  (data || []).map(r => r.data),
      updatedAt: mostRecentUpdate,
      count:     data?.length ?? 0,
    };
  } catch (e) {
    console.error("[HL Storage] getFixturesByWindow failed:", e.message);
    return { fixtures: [], updatedAt: null, count: 0 };
  }
}

/**
 * Fetch today's fixtures across all leagues.
 * Used by the live score poller to know which matches to watch.
 */
async function getTodayFixtures(date) {
  const day = date || new Date().toISOString().split("T")[0];
  try {
    const { data, error } = await supabase
      .from("hl_fixtures")
      .select("data, status")
      .gte("start_date", `${day}T00:00:00.000Z`)
      .lt("start_date",  `${day}T23:59:59.999Z`);

    if (error) throw error;
    return (data || []).map(r => r.data);
  } catch (e) {
    console.error("[HL Storage] getTodayFixtures failed:", e.message);
    return [];
  }
}

/**
 * Update live score and status for a single match.
 * Called every 60s for in-progress matches.
 */
async function updateLiveFixture(fixture) {
  return dbWriteQueue.enqueue(async () => {
    try {
      const { error } = await supabase
        .from("hl_fixtures")
        .update({
          status:     fixture.status,
          home_score: fixture.score1 || null,
          away_score: fixture.score2 || null,
          result:     fixture.statusText || null,
          data:       fixture,
          updated_at: NOW(),
        })
        .eq("id", fixture.id);

      if (error) throw error;
    } catch (e) {
      console.error("[HL Storage] updateLiveFixture failed:", e.message);
    }
  }, 'high'); // live scores are user-visible — jump the queue
}

/**
 * Return distinct league_ids that have fixtures in the ±N-day window.
 * Used by the league-list builder to surface auto-discovered leagues.
 */
async function getDiscoveredLeagueIds(daysBefore = 180, daysAhead = 180) {
  try {
    const from = new Date(Date.now() - daysBefore * 86_400_000).toISOString().slice(0, 10);
    const to   = new Date(Date.now() + daysAhead  * 86_400_000).toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from("hl_fixtures")
      .select("league_id")
      .gte("start_date", `${from}T00:00:00.000Z`)
      .lte("start_date", `${to}T23:59:59.999Z`);
    if (error) throw error;
    return [...new Set((data || []).map(r => String(r.league_id)).filter(Boolean))];
  } catch (e) {
    console.error("[HL Storage] getDiscoveredLeagueIds failed:", e.message);
    return [];
  }
}

/**
 * Fetch hl_leagues metadata for a list of IDs.
 */
async function getLeagueMeta(leagueIds) {
  if (!leagueIds?.length) return [];
  try {
    const { data, error } = await supabase
      .from("hl_leagues")
      .select("id, name, sport, country_name, country_code, logo")
      .in("id", leagueIds);
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.error("[HL Storage] getLeagueMeta failed:", e.message);
    return [];
  }
}

/**
 * Compute H2H win probability for two teams from their historical head-to-head
 * record stored in hl_fixtures. Returns null if fewer than 2 decisive matches exist.
 */
async function computeH2HPrediction(team1Id, team2Id, team1Name, team2Name) {
  try {
    const t1 = String(team1Id || "");
    const t2 = String(team2Id || "");
    if (!t1 || !t2 || t1 === t2) return null;

    const { data, error } = await supabase
      .from("hl_fixtures")
      .select("data")
      .or(
        `and(home_team_id.eq.${t1},away_team_id.eq.${t2}),` +
        `and(home_team_id.eq.${t2},away_team_id.eq.${t1})`
      )
      .eq("status", "completed")
      .order("start_date", { ascending: false })
      .limit(20);

    if (error || !data?.length) return null;

    let t1Wins = 0, t2Wins = 0;
    for (const row of data) {
      const f      = row.data;
      const winner = (f.winner || "").toLowerCase();
      if (!winner) continue;

      const isT1Home  = String(f.team1?.id) === t1;
      const myT1Name  = ((isT1Home ? f.team1?.name : f.team2?.name) || team1Name || "").toLowerCase();
      const myT2Name  = ((isT1Home ? f.team2?.name : f.team1?.name) || team2Name || "").toLowerCase();
      const t1Word    = myT1Name.split(" ")[0];
      const t2Word    = myT2Name.split(" ")[0];

      if (t1Word && winner.includes(t1Word))      t1Wins++;
      else if (t2Word && winner.includes(t2Word)) t2Wins++;
    }

    const total = t1Wins + t2Wins;
    if (total < 2) return null; // not enough decisive history

    return {
      team1Pct:    Math.round((t1Wins / total) * 100),
      team2Pct:    100 - Math.round((t1Wins / total) * 100),
      h2hMatches:  data.length,
      team1Wins:   t1Wins,
      team2Wins:   t2Wins,
      confidence:  total >= 5 ? "medium" : "low",
      generatedAt: NOW(),
    };
  } catch (e) {
    console.error("[HL Storage] computeH2HPrediction failed:", e.message);
    return null;
  }
}

/**
 * Merge a pre-computed prediction object into a fixture's data JSON column.
 */
async function updateFixturePrediction(matchId, prediction) {
  return dbWriteQueue.enqueue(async () => {
    try {
      const { data: row, error } = await supabase
        .from("hl_fixtures")
        .select("data")
        .eq("id", String(matchId))
        .single();
      if (error || !row?.data) return;
      const updated = { ...row.data, prediction };
      await supabase
        .from("hl_fixtures")
        .update({ data: updated, updated_at: NOW() })
        .eq("id", String(matchId));
    } catch (e) {
      console.error(`[HL Storage] updateFixturePrediction(${matchId}) failed:`, e.message);
    }
  }, 'low'); // best-effort background enrichment — never ahead of live writes
}

// ── Scorecards ────────────────────────────────────────────────

/**
 * Store a full scorecard. Scorecards are permanent — once stored they
 * are served directly without ever hitting the API again.
 */
async function storeScorecard(matchId, data) {
  return dbWriteQueue.enqueue(async () => {
    try {
      const { error } = await supabase
        .from("hl_scorecards")
        .upsert({ match_id: matchId, data, updated_at: NOW() }, { onConflict: "match_id" });
      if (error) throw error;
      console.log(`[HL Storage] scorecard stored for match ${matchId}`);
    } catch (e) {
      console.error("[HL Storage] storeScorecard failed:", e.message);
    }
  }, 'high'); // scorecard is user-requested data — serve promptly
}

/** Fetch a stored scorecard. Returns null if not yet stored. */
async function getScorecard(matchId) {
  try {
    const { data, error } = await supabase
      .from("hl_scorecards")
      .select("data")
      .eq("match_id", String(matchId))
      .single();

    if (error || !data) return null;
    return data.data;
  } catch {
    return null;
  }
}

/**
 * Get IDs of completed fixtures that don't yet have a scorecard stored.
 * Used by the sync job to know what to backfill.
 */
async function getMissingScorecardIds(leagueId, season) {
  try {
    const { fixtures } = await getFixtures(leagueId, season);
    const completedIds = fixtures
      .filter(f => f.status === "completed")
      .map(f => f.id);

    if (!completedIds.length) return [];

    const { data, error } = await supabase
      .from("hl_scorecards")
      .select("match_id")
      .in("match_id", completedIds);

    if (error) throw error;
    const stored = new Set((data || []).map(r => r.match_id));
    return completedIds.filter(id => !stored.has(id));
  } catch (e) {
    console.error("[HL Storage] getMissingScorecardIds failed:", e.message);
    return [];
  }
}

// ── Standings ─────────────────────────────────────────────────

/** Store a normalized standings array for a league season. */
async function storeStandings(leagueId, season, data) {
  const id = `${leagueId}:${season}`;
  return dbWriteQueue.enqueue(async () => {
    try {
      const { error } = await supabase
        .from("hl_standings")
        .upsert({ id, league_id: String(leagueId), season: Number(season), data, updated_at: NOW() }, { onConflict: "id" });
      if (error) throw error;
      console.log(`[HL Storage] standings stored (${leagueId}:${season})`);
    } catch (e) {
      console.error("[HL Storage] storeStandings failed:", e.message);
    }
  });
}

/** Fetch stored standings. Returns { standings, updatedAt }. */
async function getStandings(leagueId, season) {
  try {
    const { data, error } = await supabase
      .from("hl_standings")
      .select("data, updated_at")
      .eq("id", `${leagueId}:${season}`)
      .single();

    if (error || !data) return { standings: null, updatedAt: null };
    return { standings: data.data, updatedAt: data.updated_at };
  } catch {
    return { standings: null, updatedAt: null };
  }
}

// ── Teams ─────────────────────────────────────────────────────

/** Upsert team objects extracted from fixtures. */
async function storeTeams(teams) {
  if (!teams?.length) return;
  const unique = new Map();
  for (const t of teams) {
    if (t?.id) unique.set(String(t.id), t);
  }
  const rows = [...unique.values()].map(t => ({
    id:           String(t.id),
    name:         t.name         || "",
    abbreviation: t.shortName    || t.abbreviation || "",
    logo:         t.logo         || "",
    sport:        t.sport        || "cricket",
    data:         t,
    updated_at:   NOW(),
  }));
  if (!rows.length) return;
  return dbWriteQueue.enqueue(() => _upsert("hl_teams", rows, "id"));
}

/** Fetch all teams that appear in fixtures for a given Highlightly leagueId. */
async function getTeamsByLeague(hlId) {
  try {
    const { data: rows } = await supabase
      .from("hl_fixtures")
      .select("data")
      .eq("league_id", String(hlId))
      .not("data", "is", null)
      .limit(200);

    if (!rows?.length) return [];

    const teamMap = new Map();
    for (const row of rows) {
      const d = row.data;
      if (!d) continue;
      for (const team of [d.team1, d.team2]) {
        if (team?.id && !teamMap.has(String(team.id))) {
          teamMap.set(String(team.id), {
            id:        String(team.id),
            name:      team.name      || "",
            shortName: team.shortName || team.name?.slice(0, 4).toUpperCase() || "",
            logo:      team.logo      || "",
          });
        }
      }
    }

    return [...teamMap.values()].filter(t => t.name).sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    console.warn("[Storage] getTeamsByLeague error:", e.message);
    return [];
  }
}

/** Fetch all teams for a sport. */
async function getTeams(sport = "cricket") {
  try {
    const { data, error } = await supabase
      .from("hl_teams")
      .select("data")
      .eq("sport", sport);

    if (error) return [];
    return (data || []).map(r => r.data);
  } catch {
    return [];
  }
}

/**
 * Enrich an array of normalized fixtures with team logos from hl_teams.
 * Called when serving fixtures — fills in logos that weren't in the API
 * fixture response but were fetched separately via /cricket/teams.
 */
async function enrichFixturesWithLogos(fixtures) {
  if (!fixtures?.length) return fixtures;
  try {
    const teamIds = [...new Set(
      fixtures.flatMap(f => [String(f.team1?.id || ""), String(f.team2?.id || "")]).filter(Boolean)
    )];
    if (!teamIds.length) return fixtures;

    const { data } = await supabase
      .from("hl_teams")
      .select("id, logo, abbreviation")
      .in("id", teamIds);

    const logoMap = new Map((data || []).map(t => [String(t.id), { logo: t.logo || "", abbreviation: t.abbreviation || "" }]));
    if (!logoMap.size) return fixtures;

    return fixtures.map(f => {
      const t1 = logoMap.get(String(f.team1?.id || ""));
      const t2 = logoMap.get(String(f.team2?.id || ""));
      return {
        ...f,
        team1: f.team1 ? {
          ...f.team1,
          logo:      f.team1.logo      || t1?.logo      || "",
          shortName: f.team1.shortName || t1?.abbreviation || f.team1.shortName,
        } : f.team1,
        team2: f.team2 ? {
          ...f.team2,
          logo:      f.team2.logo      || t2?.logo      || "",
          shortName: f.team2.shortName || t2?.abbreviation || f.team2.shortName,
        } : f.team2,
      };
    });
  } catch (e) {
    console.warn("[HL Storage] enrichFixturesWithLogos failed:", e.message);
    return fixtures;
  }
}

// ── Highlights ────────────────────────────────────────────────

/** Permanently store highlight clips. Safe to re-run — upserts on id. */
async function storeHighlights(highlights) {
  if (!highlights?.length) return;
  const rows = highlights.map(h => ({
    id:        String(h.id),
    match_id:  String(h.matchId || h.match?.id || ""),
    league_id: String(h.match?.league?.id || ""),
    title:     h.title     || "",
    url:       h.url       || "",
    embed_url: h.embedUrl  || h.embed_url || "",
    img_url:   h.imgUrl    || h.img_url   || "",
    category:  h.category  || "",
    source:    h.source    || "",
    data:      h,
    created_at: NOW(),
  }));
  return dbWriteQueue.enqueue(async () => {
    await _upsert("hl_highlights", rows, "id");
    console.log(`[HL Storage] ${rows.length} highlights stored`);
  }, 'low');
}

/**
 * Fetch recent highlights across all leagues.
 * Params: sport ('cricket'|'football'|null), category, limit.
 */
async function getRecentHighlights({ sport = null, category = null, limit = 40 } = {}) {
  try {
    let query = supabase
      .from("hl_highlights")
      .select("data")
      .not("embed_url", "is", null)
      .neq("embed_url", "")
      .order("created_at", { ascending: false })
      .limit(sport || category ? Math.min(limit * 3, 200) : limit); // over-fetch so we can filter

    if (category) query = query.eq("category", category);

    const { data, error } = await query;
    if (error) return [];

    let results = (data || []).map(r => r.data).filter(h => h?.embedUrl || h?.imgUrl);
    if (sport) results = results.filter(h => h.sport === sport);
    return results.slice(0, limit);
  } catch {
    return [];
  }
}

/** Merge events, statistics, and/or prediction into a stored fixture's data JSONB. */
async function updateFixtureMatchDetail(matchId, { events, statistics, prediction, lineups } = {}) {
  return dbWriteQueue.enqueue(async () => {
    try {
      const { data: row, error } = await supabase
        .from("hl_fixtures")
        .select("data")
        .eq("id", String(matchId))
        .single();
      if (error || !row?.data) return;

      const updated = { ...row.data };
      if (events     !== undefined) updated.events     = events;
      if (statistics !== undefined) updated.statistics = statistics;
      if (prediction !== undefined) updated.prediction = prediction;
      if (lineups    !== undefined) updated.lineups    = lineups;

      await supabase
        .from("hl_fixtures")
        .update({ data: updated, updated_at: NOW() })
        .eq("id", String(matchId));
    } catch (e) {
      console.error(`[HL Storage] updateFixtureMatchDetail(${matchId}) failed:`, e.message);
    }
  });
}

/** Fetch all highlights for a match. */
async function getHighlights(matchId) {
  try {
    const { data, error } = await supabase
      .from("hl_highlights")
      .select("data")
      .eq("match_id", String(matchId))
      .order("created_at", { ascending: false });

    if (error) return [];
    return (data || []).map(r => r.data);
  } catch {
    return [];
  }
}

/** Fetch highlights for a league (latest N). */
async function getLeagueHighlights(leagueId, limit = 20) {
  try {
    const { data, error } = await supabase
      .from("hl_highlights")
      .select("data")
      .eq("league_id", String(leagueId))
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) return [];
    return (data || []).map(r => r.data);
  } catch {
    return [];
  }
}

// ── Leagues ───────────────────────────────────────────────────

/** Upsert the league registry fetched from /cricket/leagues. */
async function storeLeagues(leagues) {
  if (!leagues?.length) return;
  const rows = leagues.map(l => ({
    id:           String(l.id),
    name:         l.name           || "",
    sport:        l.sport          || "cricket",
    country_code: l.country?.code  || "",
    country_name: l.country?.name  || "",
    logo:         l.logo || l.image || l.imageUrl || l.imagePath || "",
    seasons:      l.seasons        || [],
    data:         l,
    updated_at:   NOW(),
  }));
  return dbWriteQueue.enqueue(() => _upsert("hl_leagues", rows, "id"));
}

// ── Players ───────────────────────────────────────────────────

/**
 * Upsert the player registry fetched from /cricket/players.
 * Builds the permanent player database for stats and predictions.
 */
async function storePlayers(players) {
  if (!players?.length) return;
  const unique = new Map();
  for (const p of players) {
    if (p?.id) unique.set(String(p.id), p);
  }
  const rows = [...unique.values()].map(p => ({
    id:            String(p.id),
    name:          p.name                                               || "",
    date_of_birth: p.dateOfBirth || p.dob                              || null,
    nationality:   p.nationality || p.country?.name                    || "",
    batting_style: (Array.isArray(p.battingStyles) ? p.battingStyles[0] : p.battingStyle) || "",
    bowling_style: (Array.isArray(p.bowlingStyles) ? p.bowlingStyles[0] : p.bowlingStyle) || "",
    roles:         p.roles || [],
    image:         p.image || p.logo || p.imageUrl || p.imagePath      || "",
    sport:         p.sport || "cricket",
    data:          p,
    updated_at:    NOW(),
  }));
  return dbWriteQueue.enqueue(async () => {
    await _upsert("hl_players", rows, "id");
    console.log(`[HL Storage] ${rows.length} players stored`);
  }, 'low');
}

/** Fetch a player by ID. */
async function getPlayer(playerId) {
  try {
    const { data, error } = await supabase
      .from("hl_players")
      .select("data")
      .eq("id", String(playerId))
      .single();
    if (error || !data) return null;
    return data.data;
  } catch {
    return null;
  }
}

/** Search players by name prefix (for autocomplete, own-API use). */
async function searchPlayers(query, limit = 20) {
  try {
    const { data, error } = await supabase
      .from("hl_players")
      .select("id, name, nationality, batting_style, bowling_style, roles, image")
      .ilike("name", `%${query}%`)
      .limit(limit);
    if (error) return [];
    return data || [];
  } catch {
    return [];
  }
}

/**
 * Upsert aggregated player stats for a single league-season.
 * Derived from scorecard data — accumulates across all matches in the season.
 */
async function storePlayerSeasonStats(stats) {
  if (!stats?.length) return;
  const rows = stats.map(s => ({
    id:            `${s.playerId}:${s.leagueId}:${s.season}`,
    player_id:     String(s.playerId),
    player_name:   s.playerName || "",
    league_id:     String(s.leagueId),
    season:        Number(s.season),
    sport:         s.sport || "cricket",
    innings:       s.innings       || 0,
    runs:          s.runs          || 0,
    balls_faced:   s.ballsFaced    || 0,
    highest_score: s.highestScore  || 0,
    fifties:       s.fifties       || 0,
    hundreds:      s.hundreds      || 0,
    fours:         s.fours         || 0,
    sixes:         s.sixes         || 0,
    strike_rate:   s.strikeRate    || 0,
    average:       s.average       || 0,
    overs_bowled:  s.oversBowled   || 0,
    wickets:       s.wickets       || 0,
    runs_conceded: s.runsConceded  || 0,
    economy:       s.economy       || 0,
    best_bowling:  s.bestBowling   || "",
    updated_at:    NOW(),
  }));
  return dbWriteQueue.enqueue(() => _upsert("hl_player_stats", rows, "id"), 'low');
}

// ── Player batting history (for prediction engine) ────────────
// Aggregates historical batting records from stored scorecards.

async function getPlayerBattingHistory(playerName, leagueIds = []) {
  try {
    let query = supabase.from("hl_scorecards").select("match_id, data");
    const { data, error } = await query;
    if (error || !data) return [];

    const records = [];
    for (const row of data) {
      for (const inning of (row.data.innings || [])) {
        for (const b of (inning.batsmen || [])) {
          if (b.name === playerName && b.balls >= 5) {
            records.push({
              matchId:  row.match_id,
              runs:     b.runs,
              balls:    b.balls,
              dismissal: b.dismissal,
              strikeRate: b.strikeRate,
              team:     inning.team,
            });
          }
        }
      }
    }
    return records;
  } catch (e) {
    console.error("[HL Storage] getPlayerBattingHistory failed:", e.message);
    return [];
  }
}

// ── Season-scoped warehouse queries ───────────────────────────
// Used by leagueService for past seasons and by leagueController for
// season availability checks. Each cricket season has its own HL league_id,
// so no date filter is needed for cricket — every row belongs to that season.
// Football uses one HL id for all seasons, so date range differentiates them.

// Cricket: one unique HL league_id per season — return all fixtures for it.
async function getFixturesBySeason(leagueId) {
  try {
    const { data, error } = await supabase
      .from("hl_fixtures")
      .select("data, updated_at")
      .eq("league_id", String(leagueId))
      .order("start_date", { ascending: true });
    if (error) throw error;
    const mostRecentUpdate = data?.length
      ? data.reduce((max, r) => (r.updated_at > max ? r.updated_at : max), data[0].updated_at)
      : null;
    return { fixtures: (data || []).map(r => r.data), updatedAt: mostRecentUpdate, count: data?.length ?? 0 };
  } catch (e) {
    console.error("[HL Storage] getFixturesBySeason failed:", e.message);
    return { fixtures: [], updatedAt: null, count: 0 };
  }
}

async function hasFixturesForSeason(leagueId) {
  try {
    const { count, error } = await supabase
      .from("hl_fixtures")
      .select("id", { count: "exact", head: true })
      .eq("league_id", String(leagueId));
    return !error && (count ?? 0) > 0;
  } catch {
    return false;
  }
}

// Football: one league_id for all seasons; filter by approximate season date range.
// Football seasons run Aug(year-1)–Jun(year), e.g. 2026 = Aug 2025–Jun 2026.
async function hasFixturesForFootballSeason(leagueId, year) {
  try {
    const from = `${year - 1}-07-01T00:00:00.000Z`;
    const to   = `${year}-07-31T23:59:59.999Z`;
    const { count, error } = await supabase
      .from("hl_fixtures")
      .select("id", { count: "exact", head: true })
      .eq("league_id", String(leagueId))
      .gte("start_date", from)
      .lte("start_date", to);
    return !error && (count ?? 0) > 0;
  } catch {
    return false;
  }
}

// Batch check which match IDs have a stored scorecard row.
// Returns a Set of match_id strings that exist in hl_scorecards.
async function getScorecardAvailability(matchIds) {
  if (!matchIds?.length) return new Set();
  try {
    const { data, error } = await supabase
      .from("hl_scorecards")
      .select("match_id")
      .in("match_id", matchIds.map(String));
    if (error) throw error;
    return new Set((data || []).map(r => r.match_id));
  } catch (e) {
    console.error("[HL Storage] getScorecardAvailability failed:", e.message);
    return new Set();
  }
}

// Football: fetch all fixtures for a specific season year from the warehouse.
// Football seasons run Aug(year-1)–Jun(year), e.g. 2026 = Aug 2025–Jun 2026.
async function getFixturesByFootballSeason(leagueId, year) {
  try {
    const from = `${year - 1}-07-01T00:00:00.000Z`;
    const to   = `${year}-07-31T23:59:59.999Z`;
    const { data, error } = await supabase
      .from("hl_fixtures")
      .select("data, updated_at")
      .eq("league_id", String(leagueId))
      .gte("start_date", from)
      .lte("start_date", to)
      .order("start_date", { ascending: true });
    if (error) throw error;
    const mostRecentUpdate = data?.length
      ? data.reduce((max, r) => (r.updated_at > max ? r.updated_at : max), data[0].updated_at)
      : null;
    return { fixtures: (data || []).map(r => r.data), updatedAt: mostRecentUpdate, count: data?.length ?? 0 };
  } catch (e) {
    console.error("[HL Storage] getFixturesByFootballSeason failed:", e.message);
    return { fixtures: [], updatedAt: null, count: 0 };
  }
}

module.exports = {
  // Fixtures
  storeFixtures,
  getFixtures,
  getFixturesByWindow,
  getTodayFixtures,
  // Discovery & predictions
  getDiscoveredLeagueIds,
  getLeagueMeta,
  computeH2HPrediction,
  updateFixturePrediction,
  updateFixtureMatchDetail,
  updateLiveFixture,
  enrichFixturesWithLogos,
  // Scorecards
  storeScorecard,
  getScorecard,
  getMissingScorecardIds,
  // Standings
  storeStandings,
  getStandings,
  // Teams
  storeTeams,
  getTeams,
  getTeamsByLeague,
  // Highlights
  storeHighlights,
  getHighlights,
  getLeagueHighlights,
  getRecentHighlights,
  // Leagues
  storeLeagues,
  // Players
  storePlayers,
  getPlayer,
  searchPlayers,
  storePlayerSeasonStats,
  // Analytics
  getPlayerBattingHistory,
  // Season availability + scoped warehouse reads
  hasFixturesForSeason,
  hasFixturesForFootballSeason,
  getFixturesBySeason,
  getFixturesByFootballSeason,
  getScorecardAvailability,
};
