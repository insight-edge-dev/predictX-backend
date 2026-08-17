/**
 * highlightlySyncService.js — Background data warehouse sync jobs.
 *
 * This is the engine that keeps the database full. It runs on intervals
 * and proactively fetches data from Highlightly so every league's fixture
 * history, scorecards, standings, and highlights are always stored
 * permanently — even if the API stops tomorrow.
 *
 * Jobs:
 *   syncTodayMatches()          — runs every 60 s: update today's scores
 *   syncCompletedScorecards()   — runs hourly: backfill missing scorecards
 *   syncAllActiveLeagues()      — runs daily: refresh all league fixtures
 *   syncLeagueHighlights()      — runs daily: collect highlight clips
 *   start()                     — registers all intervals, call from server.js
 */

const hl      = require("./highlightlyService");
const storage = require("./highlightlyStorageService");
const { withSyncLog } = require("./syncLogger");
const { delCache, setCache } = require("./cacheService");
const { dbWriteQueue } = require("./dbWriteQueue");
const {
  normalizeFixture,
  normalizeFootballFixture,
  normalizeLiveDetail,
  normalizeScorecard,
  normalizeStandings,
  normalizeHighlight,
  normalizeFootballEvents,
  normalizeFootballStats,
  normalizeFootballPredictions,
  normalizeFootballLineups,
} = require("./highlightlyNormalizer");
const { getAllActiveLeagues, HL_CRICKET_LEAGUES, HL_FOOTBALL_LEAGUES, getLeagueByHLId } = require("../config/highlightlyConfig");
const supabase = require("../config/supabase");

// All known franchise/domestic league IDs — anything else is auto-discovered
const FRANCHISE_IDS = new Set(
  Object.values(HL_CRICKET_LEAGUES)
    .flatMap(l => Object.values(l.seasons).map(String))
);

// ── Heavy-job mutex ───────────────────────────────────────────
// Only one "heavy" sync (daily fixture refresh, football sync, historical sync)
// may run at a time. Prevents daily + weekly jobs overlapping and doubling
// the write load on the NANO Postgres connection pool.

let _heavySyncRunning = false;

async function _withHeavySync(name, fn) {
  if (dbWriteQueue.isCircuitOpen) {
    console.log(`[HL Sync] ${name}: circuit open — DB recovering, skipping`);
    return;
  }
  if (_heavySyncRunning) {
    console.log(`[HL Sync] ${name}: heavy sync already running — skipping`);
    return;
  }
  _heavySyncRunning = true;
  try {
    await fn();
  } finally {
    _heavySyncRunning = false;
  }
}

// Per-league cooldown for auto-discovered leagues — prevents re-syncing on every 60s poll
const _newLeagueLastSynced = new Map(); // leagueId → timestamp

// ── Auto-prediction ───────────────────────────────────────────

/**
 * For every upcoming fixture in the list, compute an H2H win probability
 * from historical hl_fixtures data and persist it on the fixture row.
 * Runs with a 50 ms delay between rows to stay within DB rate limits.
 * Silently skips matches with no H2H history.
 */
async function autoComputePredictions(fixtures = []) {
  const upcoming = fixtures.filter(
    f => f.status === "upcoming" && f.team1?.id && f.team2?.id
  );
  if (!upcoming.length) return;

  let computed = 0;
  for (const f of upcoming) {
    try {
      const pred = await storage.computeH2HPrediction(
        f.team1.id, f.team2.id, f.team1.name, f.team2.name
      );
      if (pred) {
        await storage.updateFixturePrediction(f.id, pred);
        computed++;
      }
    } catch {}
    await _delay(50);
  }
  if (computed) console.log(`[HL Sync] auto-predictions: ${computed}/${upcoming.length} computed`);
}

// ── Warehouse data guard ──────────────────────────────────────
// Returns true if hl_fixtures has >50 rows updated in the last 7 days.
// Used to skip the expensive boot-time historical sync on server restarts
// when the warehouse is already populated — preventing Disk IO exhaustion
// on the Supabase free tier.

async function _warehouseHasRecentData() {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    const { count, error } = await supabase
      .from("hl_fixtures")
      .select("*", { count: "exact", head: true })
      .gte("updated_at", sevenDaysAgo);
    if (error) return false;
    return (count ?? 0) > 50;
  } catch {
    return false;
  }
}

// ── Match-day live hours (IST) ────────────────────────────────
// IPL matches are typically 19:30 – 23:30 IST, afternoons at 15:30.
// We poll continuously from 14:00 – 24:00 IST to cover both windows.

function _isMatchHour() {
  const istHour = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Kolkata", hour: "numeric", hour12: false,
  });
  const h = Number(istHour);
  return h >= 14 && h <= 23;
}

// ── Today's matches ───────────────────────────────────────────

/**
 * Fetch today's cricket matches from the API and update the warehouse.
 * Also enriches live matches with batting/bowling detail.
 */
async function syncTodayMatches() {
  if (dbWriteQueue.isCircuitOpen) return; // DB recovering — skip this poll, try next minute
  const today = new Date().toISOString().split("T")[0];
  try {
    const raw = await hl.getMatches({ date: today });
    if (!raw?.length) return;

    // Seed the shared today-cache used by leagueService.getLeagueLiveMatches.
    // This eliminates redundant per-league API calls — they'll get a cache hit.
    setCache("hl:today:cricket", raw, 90);

    const fixtures = raw.map(normalizeFixture).filter(Boolean);
    if (!fixtures.length) return;

    // For each live match, enrich with batting/bowling detail
    const enriched = await Promise.all(
      fixtures.map(async f => {
        if (f.status !== "live") return f;
        try {
          const detail = await hl.getMatchDetail(f.id);
          return detail ? normalizeLiveDetail(detail, f) : f;
        } catch {
          return f;
        }
      })
    );

    await storage.storeFixtures(enriched);
    await autoComputePredictions(enriched).catch(() => {});

    // Collect teams from today's fixtures
    const teams = enriched.flatMap(f => [f.team1, f.team2]).filter(t => t?.id);
    await storage.storeTeams(teams);

    const live     = enriched.filter(f => f.status === "live").length;
    const upcoming = enriched.filter(f => f.status === "upcoming").length;
    console.log(`[HL Sync] today: ${enriched.length} matches stored (${live} live, ${upcoming} upcoming)`);

    // Auto-discover new leagues in today's data and sync their full schedule
    await syncNewLeagueSchedules(enriched).catch(() => {});

    // For franchise leagues playing TODAY that have no warehouse data (or stale >24 h),
    // immediately sync their full schedule.  This catches leagues like The Hundred, MLC,
    // LPL that are in FRANCHISE_IDS (so skipped by syncNewLeagueSchedules) but haven't
    // been populated yet by the daily syncAllActiveLeagues job.
    await syncMissingFranchiseFixtures(enriched).catch(() => {});
  } catch (e) {
    console.warn("[HL Sync] syncTodayMatches failed:", e.message);
  }
}

/**
 * For each franchise league that appears in today's matches, check if the warehouse
 * has recent fixture data.  If missing or >24 h stale, fetch the full season now.
 * Runs inside syncTodayMatches so it fires on every successful 60-second poll.
 */
async function syncMissingFranchiseFixtures(todayFixtures = []) {
  const STALE_MS = 24 * 60 * 60_000; // 24 h — refresh once a day at most

  const franchiseHlIds = [...new Set(
    todayFixtures
      .map(f => String(f.leagueId || ""))
      .filter(id => id && FRANCHISE_IDS.has(id))
  )];

  if (!franchiseHlIds.length) return;

  for (const hlId of franchiseHlIds) {
    try {
      const conf = getLeagueByHLId(hlId);
      if (!conf) continue;

      const { count, updatedAt } = await storage.getFixturesByWindow(hlId);
      const ageMs = updatedAt ? Date.now() - new Date(updatedAt).getTime() : Infinity;

      if (count > 0 && ageMs < STALE_MS) continue; // warehouse is fresh — skip

      console.log(`[HL Sync] franchise ${conf.slug}: no/stale warehouse data — syncing full schedule`);
      await syncLeagueFixtures(conf.slug, conf.currentSeason);
      await _delay(800);
    } catch (e) {
      // silently skip — will retry on next 60s poll
    }
  }
}

/**
 * Auto-discovers new leagueIds from today's fixtures (not in our franchise registry)
 * and fetches their complete schedule so the full series appears in the app.
 * Runs after syncTodayMatches so new leagues are picked up automatically.
 */
async function syncNewLeagueSchedules(todayFixtures = []) {
  const COOLDOWN_MS = 6 * 60 * 60_000; // re-sync at most once per 6 hours per league

  const newIds = [...new Set(
    todayFixtures
      .map(f => String(f.leagueId || ""))
      .filter(id => id && !FRANCHISE_IDS.has(id))
  )];

  if (!newIds.length) return;

  const toSync = newIds.filter(id => {
    const last = _newLeagueLastSynced.get(id);
    return !last || (Date.now() - last) > COOLDOWN_MS;
  });

  if (!toSync.length) return; // all auto-discovered leagues are fresh

  console.log(`[HL Sync] auto-discovering ${toSync.length} new leagues:`, toSync.join(", "));

  for (const leagueId of toSync) {
    try {
      const raw = await hl.getMatches({ leagueId, limit: 100 });
      if (!raw?.length) continue;
      const fixtures = raw.map(normalizeFixture).filter(Boolean);
      if (fixtures.length) {
        await storage.storeFixtures(fixtures);
        await autoComputePredictions(fixtures).catch(() => {});
        const teams = fixtures.flatMap(f => [f.team1, f.team2]).filter(t => t?.id);
        await storage.storeTeams(teams);
        console.log(`[HL Sync] new league ${leagueId}: ${fixtures.length} fixtures stored`);
        _newLeagueLastSynced.set(leagueId, Date.now());
      }
      await _delay(500);
    } catch (e) {
      console.warn(`[HL Sync] new league ${leagueId} sync failed:`, e.message);
    }
  }
}

// ── Scorecards ────────────────────────────────────────────────

/**
 * Fetch and store the full scorecard for a single completed match.
 * Skips if scorecard is already stored (permanent once written).
 */
async function syncScorecard(matchId) {
  const existing = await storage.getScorecard(matchId);
  if (existing) return existing;

  try {
    const detail = await hl.getMatchDetail(matchId);
    if (!detail?.statistics?.length) return null;

    const scorecard = normalizeScorecard(detail, matchId);
    if (scorecard) await storage.storeScorecard(matchId, scorecard);
    return scorecard;
  } catch (e) {
    console.warn(`[HL Sync] syncScorecard(${matchId}) failed:`, e.message);
    return null;
  }
}

/**
 * For a given league season, backfill scorecards for all completed
 * matches that don't yet have one. Runs with 400 ms delay between
 * requests to stay within API rate limits.
 */
async function syncCompletedScorecards(slug, season) {
  const league = HL_CRICKET_LEAGUES[slug];
  if (!league) return;
  const leagueId = league.seasons[Number(season)];
  if (!leagueId) return;

  const missing = await storage.getMissingScorecardIds(leagueId, season);
  if (!missing.length) {
    console.log(`[HL Sync] ${slug} ${season}: all scorecards present`);
    return;
  }

  // Limit batch to 3 per league per hourly run so we never exhaust the daily
  // API quota on backfill alone.  Remaining are picked up in the next cycle.
  const BATCH_LIMIT = 3;
  const batch   = missing.slice(0, BATCH_LIMIT);
  const skipped = missing.length - batch.length;
  console.log(`[HL Sync] ${slug} ${season}: backfilling ${batch.length}/${missing.length} scorecards${skipped > 0 ? ` (${skipped} deferred)` : ""}`);
  let fetched = 0;
  for (const matchId of batch) {
    const sc = await syncScorecard(matchId);
    if (sc) fetched++;
    await _delay(1_000); // was 400 ms — more conservative
  }
  return fetched;
}

/**
 * Backfill scorecards for every active league's current season.
 */
async function syncAllMissingScorecards() {
  const active = getAllActiveLeagues();
  let total = 0;
  for (const league of active) {
    const n = await syncCompletedScorecards(league.slug, league.currentSeason);
    total += (n || 0);
    await _delay(3000); // 3s between leagues — was 1s, prevents PostgREST saturation on NANO
  }
  return { count: total };
}

// ── Fixtures ──────────────────────────────────────────────────

/**
 * Fetch and store all fixtures for a specific league season.
 * Returns the normalized fixture array.
 */
async function syncLeagueFixtures(slug, season) {
  const league = HL_CRICKET_LEAGUES[slug];
  if (!league) return [];
  const leagueId = league.seasons[Number(season)];
  if (!leagueId) return [];

  try {
    const raw = await hl.getMatches({ leagueId, season, limit: 100 });
    if (!raw?.length) return [];

    const fixtures = raw.map(normalizeFixture).filter(Boolean)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    await storage.storeFixtures(fixtures);
    await autoComputePredictions(fixtures).catch(() => {});
    const teams = fixtures.flatMap(f => [f.team1, f.team2]).filter(t => t?.id);
    await storage.storeTeams(teams);

    console.log(`[HL Sync] ${slug} ${season}: ${fixtures.length} fixtures stored`);
    return fixtures;
  } catch (e) {
    console.warn(`[HL Sync] syncLeagueFixtures(${slug}, ${season}) failed:`, e.message);
    return [];
  }
}

/**
 * Refresh fixtures for every active league. Runs daily.
 */
async function syncAllActiveLeagues() {
  return _withHeavySync("syncAllActiveLeagues", async () => {
    const active = getAllActiveLeagues();
    console.log(`[HL Sync] daily refresh: ${active.length} active leagues`);
    let total = 0;
    for (const league of active) {
      if (dbWriteQueue.isCircuitOpen) {
        console.warn("[HL Sync] syncAllActiveLeagues: circuit open — aborting batch");
        break;
      }
      const fixtures = await syncLeagueFixtures(league.slug, league.currentSeason);
      total += fixtures.length;
      await _delay(3000);
    }
    return { count: total };
  });
}

// ── Team logos ────────────────────────────────────────────────

/**
 * Fetch all teams from Highlightly and update logos in hl_teams.
 * The /cricket/matches endpoint often omits logos; /cricket/teams always has them.
 */
async function syncTeamLogos() {
  try {
    let allTeams = [];
    let offset = 0;
    while (true) {
      const page = await hl.getTeams({ limit: 100, offset });
      if (!page?.length) break;
      allTeams.push(...page);
      if (page.length < 100) break;
      offset += 100;
      await _delay(300);
    }

    const normalized = allTeams.map(t => ({
      id:        String(t.id || ""),
      name:      t.name      || "",
      shortName: t.abbreviation || t.shortName || "",
      logo:      t.logo || t.image || t.imageUrl || "",
      sport:     "cricket",
    })).filter(t => t.id);

    await storage.storeTeams(normalized);
    console.log(`[HL Sync] team logos synced: ${normalized.length} teams`);
    return normalized;
  } catch (e) {
    console.warn("[HL Sync] syncTeamLogos failed:", e.message);
    return [];
  }
}

// ── League registry ───────────────────────────────────────────

/**
 * Fetch all cricket leagues from Highlightly and store in hl_leagues.
 * Runs once at boot so league logos are available for prediction cards.
 */
async function syncLeagues() {
  try {
    let allLeagues = [], offset = 0;
    while (true) {
      const res = await hl.getLeagues({ limit: 100, offset });
      const page = res?.data || (Array.isArray(res) ? res : []);
      if (!page.length) break;
      allLeagues.push(...page);
      if (page.length < 100) break;
      offset += 100;
      await _delay(300);
    }
    if (allLeagues.length) {
      await storage.storeLeagues(allLeagues);
      delCache("all_leagues_raw_v6");
      console.log(`[HL Sync] leagues synced: ${allLeagues.length} entries`);
    }
    return allLeagues;
  } catch (e) {
    console.warn("[HL Sync] syncLeagues failed:", e.message);
    return [];
  }
}

async function syncFootballLeagues() {
  try {
    const raw = await hl.getFootballLeagues({ limit: 100 });
    const page = Array.isArray(raw) ? raw : (raw?.data || []);
    if (!page.length) return [];
    const rows = page.map(l => ({
      id:           String(l.id),
      name:         l.name              || "",
      sport:        "football",
      country_code: l.country?.code     || "",
      country_name: l.country?.name     || "",
      logo:         l.logo || l.image || l.imageUrl || l.imagePath || "",
      seasons:      l.seasons           || [],
      data:         l,
      updated_at:   new Date().toISOString(),
    }));
    await storage.storeLeagues(rows);
    console.log(`[HL Sync] football leagues synced: ${rows.length} entries`);
    return rows;
  } catch (e) {
    console.warn("[HL Sync] syncFootballLeagues failed:", e.message);
    return [];
  }
}

// ── Standings ─────────────────────────────────────────────────

/**
 * Fetch and store standings for a league season.
 */
async function syncStandings(leagueId, season) {
  try {
    const raw   = await hl.getStandings(leagueId, season);
    const table = normalizeStandings(raw);
    if (table.length) {
      await storage.storeStandings(leagueId, season, table);
      console.log(`[HL Sync] standings stored: ${table.length} teams (${leagueId}:${season})`);
    }
    return table;
  } catch (e) {
    console.warn(`[HL Sync] syncStandings(${leagueId}, ${season}) failed:`, e.message);
    return [];
  }
}

// ── Highlights ────────────────────────────────────────────────

/**
 * Fetch and store all highlights for a league season.
 */
async function syncLeagueHighlights(leagueId, season) {
  try {
    const raw = await hl.getHighlights({ leagueId, season, limit: 100 });
    if (!raw?.length) return;
    const highlights = raw.map(h => normalizeHighlight(h, "cricket")).filter(Boolean);
    await storage.storeHighlights(highlights);
    console.log(`[HL Sync] highlights: ${highlights.length} stored (league ${leagueId})`);
  } catch (e) {
    console.warn(`[HL Sync] syncLeagueHighlights(${leagueId}) failed:`, e.message);
  }
}

/**
 * Sync highlights for all active leagues.
 */
async function syncAllHighlights() {
  const active = getAllActiveLeagues();
  for (const league of active) {
    await syncLeagueHighlights(league.currentLeagueId, league.currentSeason);
    await _delay(600);
  }
}

// ── Historical sync: ALL seasons for all leagues ──────────────

/**
 * Sync ALL seasons for a single cricket league (not just the current one).
 * This builds the permanent historical record — every match ever played.
 * Rate-limited: 600 ms between season fetches.
 */
async function syncAllSeasonsForLeague(slug) {
  const league = HL_CRICKET_LEAGUES[slug];
  if (!league) return;

  const seasonEntries = Object.entries(league.seasons)
    .map(([yr, id]) => ({ year: Number(yr), id }))
    .sort((a, b) => a.year - b.year); // oldest first

  console.log(`[HL Sync] ${slug}: syncing ${seasonEntries.length} season(s): ${seasonEntries.map(s => s.year).join(", ")}`);

  let total = 0;
  for (const { year } of seasonEntries) {
    const fixtures = await syncLeagueFixtures(slug, year);
    total += fixtures.length;
    await _delay(600);
  }
  return total;
}

/**
 * Sync ALL seasons for EVERY configured cricket league.
 * This is the "build the full database" job. Runs once at boot (delayed)
 * and weekly thereafter.  Rate-limited: 2 s between leagues.
 */
async function syncAllHistoricalLeagues() {
  return _withHeavySync("syncAllHistoricalLeagues", async () => {
    const slugs = Object.keys(HL_CRICKET_LEAGUES);
    console.log(`[HL Sync] historical sync starting — ${slugs.length} leagues`);
    let total = 0;
    for (const slug of slugs) {
      if (dbWriteQueue.isCircuitOpen) {
        console.warn("[HL Sync] syncAllHistoricalLeagues: circuit open — aborting");
        break;
      }
      const n = await syncAllSeasonsForLeague(slug);
      total += (n || 0);
      await _delay(2_000);
    }
    console.log("[HL Sync] historical sync complete");
    return { count: total };
  });
}

/**
 * Backfill scorecards for the last 2 seasons of every configured league.
 * Skips matches that already have a stored scorecard (permanent once written).
 * Rate-limited: 400 ms per scorecard, 1 s between seasons, 2 s between leagues.
 */
async function syncAllHistoricalScorecards() {
  const allLeagues = Object.values(HL_CRICKET_LEAGUES);
  console.log(`[HL Sync] historical scorecard backfill — ${allLeagues.length} leagues (last 2 seasons each)`);

  for (const league of allLeagues) {
    const recentSeasons = Object.entries(league.seasons)
      .map(([yr]) => Number(yr))
      .sort((a, b) => b - a)
      .slice(0, 2);

    for (const year of recentSeasons) {
      await syncCompletedScorecards(league.slug, year);
      await _delay(1_000);
    }
    await _delay(2_000);
  }
  console.log("[HL Sync] historical scorecard backfill complete");
}

// ── Player sync ───────────────────────────────────────────────

/**
 * Sync all cricket players from Highlightly and store in hl_players.
 * Paginates through /cricket/players until all pages are fetched.
 * This builds the player registry needed for the prediction engine + own-API.
 */
async function syncPlayers() {
  try {
    let allPlayers = [], offset = 0;
    while (true) {
      const page = await hl.getPlayers({ limit: 100, offset });
      if (!page?.length) break;
      allPlayers.push(...page);
      if (page.length < 100) break;
      offset += 100;
      await _delay(300);
    }
    if (allPlayers.length) {
      await storage.storePlayers(allPlayers);
      console.log(`[HL Sync] players synced: ${allPlayers.length}`);
    }
    return allPlayers;
  } catch (e) {
    console.warn("[HL Sync] syncPlayers failed:", e.message);
    return [];
  }
}

/**
 * Extract player stats from stored scorecards for a league season and upsert
 * to hl_player_stats. Runs after scorecard backfill.
 */
async function aggregatePlayerStats(slug, season) {
  const league = HL_CRICKET_LEAGUES[slug];
  if (!league) return;
  const leagueId = league.seasons[Number(season)];
  if (!leagueId) return;

  try {
    const { fixtures } = await storage.getFixtures(leagueId, season);
    const completedIds = fixtures.filter(f => f.status === "completed").map(f => f.id);
    if (!completedIds.length) return;

    // Aggregate per-player stats from scorecards
    const statsMap = new Map(); // playerId → accumulated stats

    for (const matchId of completedIds) {
      const sc = await storage.getScorecard(matchId);
      if (!sc?.innings) continue;

      for (const inning of sc.innings) {
        for (const b of (inning.batsmen || [])) {
          if (!b.playerId) continue;
          const key  = b.playerId;
          const curr = statsMap.get(key) || {
            playerId: key, playerName: b.name, leagueId, season: Number(season),
            innings: 0, runs: 0, ballsFaced: 0, highestScore: 0,
            fifties: 0, hundreds: 0, fours: 0, sixes: 0,
          };
          curr.innings++;
          curr.runs        += b.runs  || 0;
          curr.ballsFaced  += b.balls || 0;
          curr.fours       += b.fours || 0;
          curr.sixes       += b.sixes || 0;
          if ((b.runs || 0) >= 100) curr.hundreds++;
          else if ((b.runs || 0) >= 50) curr.fifties++;
          if ((b.runs || 0) > curr.highestScore) curr.highestScore = b.runs || 0;
          statsMap.set(key, curr);
        }

        for (const b of (inning.bowlers || [])) {
          if (!b.playerId) continue;
          const key  = b.playerId;
          const curr = statsMap.get(key) || {
            playerId: key, playerName: b.name, leagueId, season: Number(season),
            innings: 0, runs: 0, ballsFaced: 0, highestScore: 0,
            fifties: 0, hundreds: 0, fours: 0, sixes: 0,
          };
          curr.oversBowled  = (curr.oversBowled  || 0) + (b.overs   || 0);
          curr.wickets      = (curr.wickets      || 0) + (b.wickets || 0);
          curr.runsConceded = (curr.runsConceded || 0) + (b.runs    || 0);
          statsMap.set(key, curr);
        }
      }
      await _delay(30); // tiny delay between scorecard reads
    }

    // Compute derived fields
    const finalStats = [...statsMap.values()].map(s => {
      const sr  = s.ballsFaced > 0 ? ((s.runs / s.ballsFaced) * 100).toFixed(2) : 0;
      const avg = s.innings    > 0 ? (s.runs / s.innings).toFixed(2)             : 0;
      const eco = s.oversBowled > 0
        ? ((s.runsConceded || 0) / s.oversBowled).toFixed(2)
        : 0;
      return { ...s, strikeRate: Number(sr), average: Number(avg), economy: Number(eco) };
    });

    await storage.storePlayerSeasonStats(finalStats);
    console.log(`[HL Sync] ${slug} ${season}: ${finalStats.length} player stat rows aggregated`);
  } catch (e) {
    console.warn(`[HL Sync] aggregatePlayerStats(${slug}, ${season}) failed:`, e.message);
  }
}

// ── Football sync (Highlightly) ───────────────────────────────

/**
 * Sync fixtures for a single Highlightly football league + season.
 * Stores to hl_fixtures with sport='football'.
 */
async function syncFootballLeague(slug, season) {
  const hlLeague = HL_FOOTBALL_LEAGUES[slug];
  if (!hlLeague) return [];

  const leagueId = hlLeague.id;
  if (!leagueId) {
    console.warn(`[HL Sync] football ${slug}: no leagueId configured`);
    return [];
  }

  try {
    const raw = await hl.getFootballMatches({ leagueId, season, limit: 100 });
    if (!raw?.length) {
      console.log(`[HL Sync] football ${slug} ${season}: no data from API`);
      return [];
    }

    const fixtures = raw.map(normalizeFootballFixture).filter(Boolean)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    await storage.storeFixtures(fixtures);
    await autoComputePredictions(fixtures).catch(() => {});
    const teams = fixtures.flatMap(f => [f.team1, f.team2]).filter(t => t?.id)
      .map(t => ({ ...t, sport: "football" }));
    await storage.storeTeams(teams);

    // Clear NodeCache so the next request reads fresh warehouse data
    delCache(`league:fixtures:${slug}`);

    console.log(`[HL Sync] football ${slug} ${season}: ${fixtures.length} fixtures stored`);
    return fixtures;
  } catch (e) {
    console.warn(`[HL Sync] syncFootballLeague(${slug}, ${season}) failed:`, e.message);
    return [];
  }
}

/**
 * Sync all Highlightly football leagues (ISL, La Liga, WC).
 * Called daily and once at boot.
 */
async function syncAllFootball() {
  return _withHeavySync("syncAllFootball", async () => {
  const slugs = Object.keys(HL_FOOTBALL_LEAGUES);
  console.log(`[HL Sync] football sync: ${slugs.length} leagues`);
  for (const slug of slugs) {
    if (dbWriteQueue.isCircuitOpen) {
      console.warn("[HL Sync] syncAllFootball: circuit open — aborting batch");
      break;
    }
    const hlLeague = HL_FOOTBALL_LEAGUES[slug];
    const season   = hlLeague.currentSeason;

    await syncFootballLeague(slug, season);
    await _delay(800);

    // Also try next season — catches leagues where a new season has started but
    // config hasn't been updated yet (e.g. La Liga 2026/27 while currentSeason=2026)
    await syncFootballLeague(slug, season + 1).catch(() => {});
    await _delay(600);

    // Standings for current season
    try {
      const raw = await hl.getFootballStandings(hlLeague.id, season);
      if (raw) {
        await storage.storeStandings(hlLeague.id, season, raw);
        console.log(`[HL Sync] football standings ${slug} ${season}: stored`);
      }
    } catch (e) {
      console.warn(`[HL Sync] football standings ${slug} failed:`, e.message);
    }
    await _delay(500);
  }

  // Enrich live/recent football fixtures with events, stats, predictions
  await syncFootballMatchDetails().catch(() => {});

  // Sync highlight clips for all football leagues
  await syncAllFootballHighlights().catch(() => {});
  }); // end _withHeavySync
}

/**
 * Sync all football leagues from Highlightly registry.
 */
async function syncFootballLeagueRegistry() {
  try {
    let all = [], offset = 0;
    while (true) {
      const page = await hl.getFootballLeagues({ limit: 100, offset });
      if (!page?.length) break;
      all.push(...page);
      if (page.length < 100) break;
      offset += 100;
      await _delay(300);
    }
    if (all.length) {
      const rows = all.map(l => ({
        id:           String(l.id),
        name:         l.name || "",
        sport:        "football",
        country_code: l.country?.code || "",
        country_name: l.country?.name || "",
        logo:         l.logo || l.image || l.imageUrl || "",
        seasons:      l.seasons || [],
        data:         l,
        updated_at:   new Date().toISOString(),
      }));
      await storage.storeLeagues(rows.filter(r => r.id));
      delCache("all_leagues_raw_v6");
      console.log(`[HL Sync] football league registry: ${rows.length} entries stored`);
    }
  } catch (e) {
    console.warn("[HL Sync] syncFootballLeagueRegistry failed:", e.message);
  }
}

/**
 * Fetch full match detail for live/recent football matches and enrich stored
 * fixtures with events (goals, cards, subs), statistics (possession, shots),
 * and API-provided win predictions (home/draw/away %).
 * Called inside syncAllFootball and also on the 60s live polling interval.
 */
async function syncFootballMatchDetails() {
  try {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const tomorrow  = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const { data } = await supabase
      .from("hl_fixtures")
      .select("data")
      .eq("sport", "football")
      .gte("start_date", `${yesterday}T00:00:00.000Z`)
      .lte("start_date", `${tomorrow}T23:59:59.999Z`)
      .in("status", ["live", "upcoming", "completed"])
      .order("start_date", { ascending: false })
      .limit(30);

    const fixtures = (data || []).map(r => r.data);
    if (!fixtures.length) return;

    let enriched = 0;
    for (const f of fixtures) {
      try {
        const detail = await hl.getFootballMatchDetail(f.id);
        if (!detail) continue;

        const events     = normalizeFootballEvents(detail.events || []);
        const statistics = normalizeFootballStats(detail.statistics || []);
        const prediction = normalizeFootballPredictions(detail.predictions);

        await storage.updateFixtureMatchDetail(f.id, { events, statistics, prediction });
        enriched++;
        await _delay(300);
      } catch {
        // silently skip — stale data is fine
      }
    }
    if (enriched) console.log(`[HL Sync] football detail enrichment: ${enriched}/${fixtures.length} matches`);
  } catch (e) {
    console.warn("[HL Sync] syncFootballMatchDetails failed:", e.message);
  }
}

/**
 * Sync highlight clips for all configured football leagues.
 */
async function syncAllFootballHighlights() {
  for (const [slug, league] of Object.entries(HL_FOOTBALL_LEAGUES)) {
    try {
      const raw = await hl.getFootballHighlights({
        leagueId: league.id,
        season:   league.currentSeason,
        limit:    40,
      });
      if (!raw?.length) continue;
      const highlights = raw.map(h => normalizeHighlight(h, "football")).filter(Boolean);
      await storage.storeHighlights(highlights);
      console.log(`[HL Sync] football highlights ${slug}: ${highlights.length} stored`);
      await _delay(500);
    } catch (e) {
      console.warn(`[HL Sync] football highlights ${slug} failed:`, e.message);
    }
  }
}

/**
 * Sync football team logos from Highlightly /football/teams.
 */
async function syncFootballTeamLogos() {
  // Highlightly has no /football/teams endpoint — football team logos
  // are populated from fixture sync (homeTeam.logo / awayTeam.logo).
}

// ── Scheduler ─────────────────────────────────────────────────

let _liveInterval   = null;
let _hourlyTimeout  = null;
let _dailyTimeout   = null;
let _weeklyTimeout  = null;

/**
 * Start all background sync jobs. Call once from server.js after boot.
 *
 * Schedule:
 *   Every 60 s  — today's match scores + live enrichment
 *   Every hour  — backfill missing scorecards for active leagues (current season)
 *   Every 24 h  — fixture refresh for all active leagues + highlights + football + intl series
 *   Every 7 d   — full historical sync for ALL seasons of ALL leagues + scorecard backfill
 *                 (this is what builds the complete sports database)
 *
 * Boot sequence (staggered to avoid simultaneous API hammer):
 *    0s  — syncTodayMatches
 *    5s  — syncTeamLogos (cricket)
 *   10s  — syncLeagues (cricket registry)
 *   15s  — syncFootballTeamLogos
 *   20s  — syncFootballLeagueRegistry
 *   45s  — syncUpcomingMatches (30-day bilateral series)
 *    2m  — syncAllFootball (ISL, La Liga, EPL, UCL, Bundesliga, Ligue 1, UEL, WC)
 *    5m  — syncPlayers (cricket player registry)
 *    2h  — syncAllHistoricalLeagues (all seasons, full database build)
 */
/**
 * Probe the DB until it responds, with exponential backoff.
 * Prevents the boot sequence from hammering a recovering Postgres instance.
 * Returns once a SELECT succeeds or the timeout elapses.
 */
async function _waitForDb(maxWaitMs = 10 * 60_000) {
  const start   = Date.now();
  let   backoff = 10_000; // 10s → 15s → 22s … capped at 60s

  while (Date.now() - start < maxWaitMs) {
    try {
      // Probe with a WRITE, not a read — NANO Postgres can briefly accept SELECTs
      // during recovery while still OOMing on writes. Confirming write capability
      // prevents the thundering-herd re-crash we saw in prod logs.
      const { error: e1 } = await supabase
        .from("worker_heartbeat")
        .upsert({ id: 1, last_seen: new Date().toISOString(), worker_pid: process.pid });

      if (!e1) {
        // One success isn't proof of stability — the DB may be oscillating.
        // Wait 20s and probe again; only proceed if both pass.
        console.log("[HL Sync] DB write probe 1/2 passed — confirming in 20s…");
        await _delay(20_000);

        const { error: e2 } = await supabase
          .from("worker_heartbeat")
          .upsert({ id: 1, last_seen: new Date().toISOString(), worker_pid: process.pid });

        if (!e2) {
          console.log("[HL Sync] DB stable (2/2 write probes passed) — starting sync jobs");
          return;
        }
        console.log("[HL Sync] DB unstable after probe 2 — restarting wait");
      }
    } catch {}

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`[HL Sync] DB not ready (${elapsed}s elapsed) — retrying in ${backoff / 1000}s`);
    await _delay(backoff);
    backoff = Math.min(Math.round(backoff * 1.5), 60_000);
  }
  console.warn("[HL Sync] DB still not responding after 10 min — proceeding anyway");
}

function start() {
  const BOOT_DELAY = 20_000;

  setTimeout(async () => {
    // Wait for DB to accept connections before firing any sync job.
    // Without this, a recovering Postgres gets saturated the moment the
    // worker restarts, keeping it in a 522-timeout loop indefinitely.
    await _waitForDb();
    // Extra settling time after the double write-probe: gives Postgres another
    // 60s to finish recycling its connection pool before any bulk sync fires.
    await _delay(60_000);

    // ── Recurring jobs ────────────────────────────────────────

    // Every 60s — today's match scores (cricket + football live enrichment)
    _liveInterval = setInterval(async () => {
      await syncTodayMatches().catch(() => {});
      if (_isMatchHour()) await syncFootballMatchDetails().catch(() => {});
    }, 60_000);

    // Hourly — scorecard backfill for current seasons
    const _hourlyJob = async () => {
      await withSyncLog("syncAllMissingScorecards", syncAllMissingScorecards).catch(() => {});
      _hourlyTimeout = setTimeout(_hourlyJob, 60 * 60_000);
    };
    setTimeout(_hourlyJob, 5 * 60_000); // first run 5 min after boot

    // Daily — fixture refresh + highlights + football + international series
    const _dailyJob = async () => {
      await withSyncLog("syncAllActiveLeagues",  syncAllActiveLeagues).catch(() => {});
      await withSyncLog("syncAllHighlights",     syncAllHighlights).catch(() => {});
      await withSyncLog("syncAllFootball",       syncAllFootball).catch(() => {});
      try {
        const intlSvc = require("./internationalService");
        await withSyncLog("syncUpcomingMatches60", () => intlSvc.syncUpcomingMatches(60));
      } catch (e) {
        console.warn("[HL Sync] syncUpcomingMatches failed:", e.message);
      }
      const db = require("./dbService");
      await db.cleanupStaleSeriesRows().catch(e => console.warn("[HL Sync] cleanup failed:", e.message));
      _dailyTimeout = setTimeout(_dailyJob, 24 * 60 * 60_000);
    };
    setTimeout(_dailyJob, 30 * 60_000); // first run 30 min after boot

    // Weekly — full historical sync for ALL seasons of ALL leagues.
    const _weeklyJob = async () => {
      await withSyncLog("syncAllHistoricalLeagues",   syncAllHistoricalLeagues).catch(() => {});
      await withSyncLog("syncAllHistoricalScorecards", syncAllHistoricalScorecards).catch(() => {});
      _weeklyTimeout = setTimeout(_weeklyJob, 7 * 24 * 60 * 60_000);
    };
    setTimeout(async () => {
      const hasData = await _warehouseHasRecentData();
      if (hasData) {
        console.log("[HL Sync] warehouse has recent data — skipping boot historical sync, next in 7 days");
        _weeklyTimeout = setTimeout(_weeklyJob, 7 * 24 * 60 * 60_000);
      } else {
        console.log("[HL Sync] warehouse empty or stale — running initial historical sync");
        await _weeklyJob().catch(e => console.warn("[HL Sync] initial historical sync failed:", e.message));
      }
    }, 2 * 60 * 60_000); // check 2h after boot

    // ── Boot-time one-off syncs ────────────────────────────────

    syncTodayMatches().catch(() => {});

    // Cricket team logos + league registry
    setTimeout(() => syncTeamLogos().catch(() => {}),              5_000);
    setTimeout(() => syncLeagues().catch(() => {}),               10_000);

    // Football league registry (logos into hl_leagues)
    setTimeout(() => syncFootballLeagueRegistry().catch(() => {}), 20_000);

    // Upcoming bilateral series (30-day window)
    setTimeout(async () => {
      try {
        const intlSvc = require("./internationalService");
        await intlSvc.syncUpcomingMatches(30);
        console.log("[HL Sync] boot: 30-day upcoming sync complete");
      } catch (e) {
        console.warn("[HL Sync] boot: 30-day sync failed:", e.message);
      }
    }, 45_000);

    // Football fixtures (ISL, La Liga, EPL, UCL etc.) — 2 min after boot.
    // Retry at 8 min ONLY if the 2-min run failed (circuit-breaker may have been active).
    let _footballBootDone = false;
    setTimeout(async () => {
      try {
        await syncAllFootball();
        _footballBootDone = true;
      } catch {}
    }, 2 * 60_000);
    setTimeout(() => {
      if (!_footballBootDone) syncAllFootball().catch(() => {});
    }, 8 * 60_000);

    // Cricket player registry — 5 min after boot
    setTimeout(() => syncPlayers().catch(() => {}), 5 * 60_000);

    console.log("[HL Sync] background jobs started (historical sync in ~2h)");
  }, BOOT_DELAY);
}

function stop() {
  if (_liveInterval)  clearInterval(_liveInterval);
  if (_hourlyTimeout) clearTimeout(_hourlyTimeout);
  if (_dailyTimeout)  clearTimeout(_dailyTimeout);
  if (_weeklyTimeout) clearTimeout(_weeklyTimeout);
}

// ── Utility ───────────────────────────────────────────────────

function _delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  // Predictions
  autoComputePredictions,
  // On-demand: today / live
  syncTodayMatches,
  syncNewLeagueSchedules,
  // Scorecards
  syncScorecard,
  syncCompletedScorecards,
  syncAllMissingScorecards,
  // Fixtures — current seasons
  syncLeagueFixtures,
  syncAllActiveLeagues,
  // Fixtures — all historical seasons (warehouse builder)
  syncAllSeasonsForLeague,
  syncAllHistoricalLeagues,
  syncAllHistoricalScorecards,
  // Teams / leagues / players
  syncTeamLogos,
  syncLeagues,
  syncPlayers,
  aggregatePlayerStats,
  // Football (Highlightly)
  syncFootballLeague,
  syncAllFootball,
  syncFootballMatchDetails,
  syncFootballTeamLogos,
  syncFootballLeagueRegistry,
  syncFootballLeagues,
  // Standings
  syncStandings,
  // Highlights
  syncLeagueHighlights,
  syncAllHighlights,
  syncAllFootballHighlights,
  // Lifecycle
  start,
  stop,
};
