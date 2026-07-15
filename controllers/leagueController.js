/**
 * leagueController.js — HTTP handlers for multi-league endpoints.
 *
 * Routes (all prefixed /api):
 *   GET /leagues                     → all Sportsmonks leagues (dynamic)
 *   GET /leagues/:slug/matches
 *   GET /leagues/:slug/live
 *   GET /leagues/:slug/upcoming
 *   GET /leagues/:slug/results
 *   GET /leagues/:slug/fixtures
 *   GET /leagues/:slug/table
 */

const { LEAGUES, FOOTBALL_LEAGUES, getLeague } = require("../config/leaguesConfig");

// Football leagues as a flat array ready for the API response
const FOOTBALL_LEAGUE_LIST = Object.values(FOOTBALL_LEAGUES).map(l => ({
  slug: l.slug, leagueId: l.leagueId, seasonId: null,
  stageId: null, playoffId: null,
  name: l.name, short: l.short, season: l.season,
  flag: l.flag, country: l.country, format: l.format, image: "",
  sport: l.sport,
}));
const leagueService            = require("../services/leagueService");
const sm                       = require("../services/sportmonksService");
const { getCache, setCache, TTL } = require("../services/cacheService");
const supabase                 = require("../config/supabase");

// Admin-set "featured/pinned" override (league_settings table) — merged onto
// every league object so the Matches/PredictX accordions can sort featured
// leagues to the top. Higher priority = shown first; 0 = no override.
async function attachPriority(leagues) {
  try {
    const { data, error } = await supabase.from("league_settings").select("slug, priority");
    if (error) throw new Error(error.message);
    const prioMap = new Map((data ?? []).map(s => [s.slug, s.priority]));
    return leagues.map(l => ({ ...l, priority: prioMap.get(l.slug) ?? 0 }));
  } catch (e) {
    console.warn("[LeagueCtrl] attachPriority failed —", e.message);
    return leagues.map(l => ({ ...l, priority: 0 }));
  }
}

// Generic international buckets that are NOT real franchise leagues — they
// contain hundreds of unrelated bilateral tours and are handled separately
// by the /api/international/* section.  Exclude them from the league picker
// so users don't accidentally select them and see an empty, unsorted list.
const INTL_BUCKET_IDS = new Set([3, 258, 261]); // T20I, Women's T20I, Women's ODI

// Minimum season year to show — filters out very old/discontinued leagues
// that haven't run since before this threshold (e.g. WCSL 2018, Finland 2020).
const MIN_SEASON_YEAR = 2024;

// ── Country → flag emoji ──────────────────────────────────────

const COUNTRY_FLAGS = {
  India:         "🏏",  Pakistan:      "🟢",  Australia:     "🦘",
  Bangladesh:    "🟥",  England:       "🏴󠁧󠁢󠁥󠁮󠁧󠁿",  "South Africa":"🦁",
  "West Indies": "🌐",  International: "🌍",  "Sri Lanka":   "🦁",
  Afghanistan:   "🏔",  "New Zealand": "🥝",  Zimbabwe:      "🌿",
  Ireland:       "☘️",  Scotland:      "🏴󠁧󠁢󠁳󠁣󠁴󠁿",  "United Arab Emirates": "🏜",
  USA:           "🇺🇸", Canada:        "🍁",  Netherlands:   "🌷",
};

function countryFlag(countryName) {
  return COUNTRY_FLAGS[countryName] ?? "🏏";
}

// Derive a URL-safe slug from Sportsmonks code/name
function makeSlug(code, name, id) {
  if (code) return code.toLowerCase().replace(/[^a-z0-9]/g, "_");
  if (name) return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 20);
  return `league_${id}`;
}

// Ensure every slug in the list is unique — append _leagueId on collision
function deduplicateSlugs(leagues) {
  const seen = new Set();
  return leagues.map(l => {
    let slug = l.slug;
    if (seen.has(slug)) slug = `${slug}_${l.leagueId}`;
    seen.add(slug);
    return { ...l, slug };
  });
}

// ── Activity window: which league IDs have fixtures right now ─
// One Sportsmonks call (date-range filter) covers all leagues at once.
// Window: 10 days ago → 45 days ahead. Cached 4 h.

const ACTIVITY_WINDOW_DAYS_BACK   = 10;
const ACTIVITY_WINDOW_DAYS_AHEAD  = 45;

async function getActiveLeagueIds() {
  const CACHE_KEY = "active_league_ids";
  const cached    = getCache(CACHE_KEY);
  if (cached) return new Set(cached);

  const now  = new Date();
  const from = new Date(now - ACTIVITY_WINDOW_DAYS_BACK  * 86_400_000).toISOString().slice(0, 10);
  const to   = new Date(now.getTime() + ACTIVITY_WINDOW_DAYS_AHEAD * 86_400_000).toISOString().slice(0, 10);

  const ids = new Set();
  for (let page = 1; page <= 3; page++) {
    const data = await sm.getFixturesInDateRange(from, to, page);
    if (!Array.isArray(data) || data.length === 0) break;
    for (const f of data) if (f.league_id) ids.add(f.league_id);
    if (data.length < 100) break;
  }

  console.log(`[LeagueCtrl] active league IDs in window: [${[...ids].join(", ")}]`);
  setCache(CACHE_KEY, [...ids], 4 * 60 * 60); // refresh every 4 h
  return ids;
}

// ── Raw league metadata (expensive — cached 24 h) ─────────────

async function buildRawLeagueList() {
  const RAW_KEY = "all_leagues_raw";
  const cached  = getCache(RAW_KEY);
  if (cached) return cached;

  const [rawLeagues, rawSeasons] = await Promise.all([
    sm.getAllLeagues(),
    sm.getRecentSeasons(),
  ]);

  if (!rawLeagues || !Array.isArray(rawLeagues) || rawLeagues.length === 0) return null;

  const seasonByLeague = {};
  if (Array.isArray(rawSeasons)) {
    for (const s of rawSeasons) {
      const lid = s.league_id ?? s.leagueId;
      if (lid && !seasonByLeague[lid]) seasonByLeague[lid] = s;
    }
  }

  const known = Object.values(LEAGUES);

  // Individually fetch seasons for leagues the batch missed
  const missing = rawLeagues.filter(l =>
    !known.find(k => k.leagueId === l.id) && !seasonByLeague[l.id]
  );
  if (missing.length > 0) {
    const chunks = [];
    for (let i = 0; i < missing.length; i += 10) chunks.push(missing.slice(i, i + 10));
    for (const chunk of chunks) {
      await Promise.all(chunk.map(async l => {
        const s = await sm.getSeasonForLeague(l.id);
        if (s) seasonByLeague[l.id] = s;
      }));
    }
  }

  const leagues = rawLeagues
    .map(l => {
      const knownConf = known.find(k => k.leagueId === l.id) ?? null;
      const slug      = knownConf?.slug ?? makeSlug(l.code, l.name, l.id);
      const season    = seasonByLeague[l.id] ?? null;
      const seasonId  = knownConf?.seasonId ?? season?.id   ?? null;
      const yearLabel = knownConf?.season   ?? String(season?.name ?? season?.year ?? "");
      return {
        slug, leagueId: l.id, seasonId,
        stageId:   knownConf?.stageId   ?? null,
        playoffId: knownConf?.playoffId ?? null,
        name:      l.name        ?? "",
        short:     knownConf?.short ?? l.code ?? l.name?.slice(0, 6) ?? "",
        season:    yearLabel,
        flag:      knownConf?.flag ?? countryFlag(l.country?.name),
        country:   l.country?.name ?? "",
        format:    knownConf?.format ?? "T20",
        image:     l.image_path  ?? "",
        sport:     "cricket",
      };
    })
    .filter(l => l.seasonId && !INTL_BUCKET_IDS.has(l.leagueId));

  const result = deduplicateSlugs([...leagues, ...FOOTBALL_LEAGUE_LIST]);
  setCache(RAW_KEY, result, TTL.DAILY);
  return result;
}

// ── GET /api/leagues ──────────────────────────────────────────
// Returns ALL accessible leagues with a `status` field:
//   'active'    — has fixtures in the -10 d / +45 d window (ongoing or upcoming)
//   'completed' — no fixtures in window (season finished)
// Raw metadata cached 24 h; activity window refreshes every 4 h.
// Leagues with seasons older than MIN_SEASON_YEAR are excluded.
// Sort order: active leagues first (known-config → alphabetical),
//             then completed leagues (known-config → alphabetical).

function seasonYear(s) {
  return parseInt(String(s || "0").slice(0, 4)) || 0;
}

async function listLeagues(_req, res) {
  try {
    // 1. Raw metadata (24 h cache)
    let raw = await buildRawLeagueList();

    if (!raw) {
      // Sportsmonks down — return full hardcoded config
      const list = Object.values(LEAGUES).map(l => ({
        slug: l.slug, leagueId: l.leagueId, seasonId: l.seasonId,
        stageId: l.stageId, playoffId: l.playoffId,
        name: l.name, short: l.short, season: l.season,
        flag: l.flag, country: l.country, format: l.format, image: "", sport: "cricket",
        status: "active",
      }));
      console.warn("[LeagueCtrl] listLeagues: Sportsmonks down — using hardcoded fallback");
      return res.json({ leagues: await attachPriority([...list, ...FOOTBALL_LEAGUE_LIST.map(l => ({ ...l, status: "active" }))]) });
    }

    // 2. Activity window (4 h cache) — used for status badge + sort, not filtering
    const activeIds = await getActiveLeagueIds();

    // 3. Filter out very old leagues (pre-MIN_SEASON_YEAR) and attach status
    const withStatus = raw
      .filter(l => l.sport === "football" || seasonYear(l.season) >= MIN_SEASON_YEAR)
      .map(l => ({
        ...l,
        status: (l.sport === "football" || activeIds.has(l.leagueId)) ? "active" : "completed",
      }));

    // 4. Sort: active first, within each group known-config leagues before
    //    auto-discovered, then alphabetical.
    const known = new Set(Object.values(LEAGUES).map(l => l.leagueId));
    withStatus.sort((a, b) => {
      const aActive = a.status === "active", bActive = b.status === "active";
      if (aActive && !bActive) return -1;
      if (!aActive && bActive) return  1;
      const aK = known.has(a.leagueId), bK = known.has(b.leagueId);
      if (aK && !bK) return -1;
      if (!aK && bK) return  1;
      return a.name.localeCompare(b.name);
    });

    const result = await attachPriority(withStatus);
    const activeCount    = result.filter(l => l.status === "active").length;
    const completedCount = result.filter(l => l.status === "completed").length;
    console.log(`[LeagueCtrl] listLeagues: ${result.length} leagues (${activeCount} active, ${completedCount} completed)`);
    res.json({ leagues: result });
  } catch (e) {
    console.error("[LeagueCtrl] listLeagues error:", e.message);
    res.status(500).json({ error: "Failed to fetch leagues" });
  }
}

// ── Resolve league from slug ──────────────────────────────────
// Checks hardcoded config first, then dynamic cache, then Sportsmonks API.

async function resolveLeagueDynamic(slug) {
  // 1. Hardcoded config
  const conf = getLeague(slug);
  if (conf) return conf;

  // 2. Dynamic cache
  const cached = getCache("all_leagues_dynamic");
  if (cached) {
    const found = cached.find(l => l.slug === slug);
    if (found) return found;
  }

  // 3. Fetch fresh from Sportsmonks
  const raw = await sm.getAllLeagues();
  if (!raw) return null;
  const known = Object.values(LEAGUES);
  const match = raw.find(l => makeSlug(l.code, l.name, l.id) === slug);
  if (!match) return null;

  // getAllLeagues() doesn't include `currentseason` — resolve it the same
  // reliable way listLeagues() does (batch seasons don't cover every league).
  const knownConf = known.find(k => k.leagueId === match.id);
  const seasonId  = knownConf?.seasonId ?? null;
  let   season    = null;
  if (!seasonId) {
    season = await sm.getSeasonForLeague(match.id);
    if (!season?.id) return null;
  }

  return {
    slug,
    leagueId:  match.id,
    seasonId:  seasonId ?? season.id,
    stageId:   knownConf?.stageId   ?? null,
    playoffId: knownConf?.playoffId ?? null,
    name:      match.name  ?? "",
    short:     match.code  ?? "",
    season:    knownConf?.season ?? String(season?.name ?? season?.year ?? ""),
    flag:      knownConf?.flag ?? countryFlag(match.country?.name),
    country:   match.country?.name ?? "",
    format:    "T20",
  };
}

// ── Helper used by all data handlers ─────────────────────────

async function resolve(req, res) {
  const league = await resolveLeagueDynamic(req.params.slug);
  if (!league) {
    res.status(404).json({ error: `Unknown league: ${req.params.slug}` });
    return null;
  }
  return league;
}

// ── GET /api/leagues/:slug/matches ────────────────────────────

async function getMatches(req, res) {
  const league = await resolve(req, res);
  if (!league) return;
  try {
    res.json(await leagueService.getLeagueMatches(league));
  } catch (e) {
    console.error(`[League:${req.params.slug}] getMatches:`, e.message);
    res.status(500).json({ error: "Failed to fetch matches" });
  }
}

async function getLive(req, res) {
  const league = await resolve(req, res);
  if (!league) return;
  try {
    const { live } = await leagueService.getLeagueMatches(league);
    res.json({ live });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch live" });
  }
}

async function getUpcoming(req, res) {
  const league = await resolve(req, res);
  if (!league) return;
  try {
    const { upcoming } = await leagueService.getLeagueMatches(league);
    res.json({ upcoming });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch upcoming" });
  }
}

async function getResults(req, res) {
  const league = await resolve(req, res);
  if (!league) return;
  try {
    const { completed } = await leagueService.getLeagueMatches(league);
    res.json({ completed });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch results" });
  }
}

async function getFixtures(req, res) {
  const league = await resolve(req, res);
  if (!league) return;
  try {
    res.json({ fixtures: await leagueService.getLeagueFixtures(league) });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch fixtures" });
  }
}

async function getTable(req, res) {
  const league = await resolve(req, res);
  if (!league) return;
  try {
    res.json({ table: await leagueService.getLeagueTable(league) });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch standings" });
  }
}

module.exports = { listLeagues, getMatches, getLive, getUpcoming, getResults, getFixtures, getTable };
