/**
 * cacheService.js — centralized NodeCache wrapper.
 *
 * All TTLs defined here — one place to tune them.
 * NodeCache uses seconds; constants below are in seconds.
 */

const NodeCache = require("node-cache");

// ── TTL constants (seconds) ───────────────────────────────────

const TTL = {
  LIVE:          30,           // live scores
  MATCH_DETAIL:  60,           // single match info
  FIXTURES:      10 * 60,      // upcoming fixtures
  RESULTS:       60 * 60,      // completed results
  SERIES:        6 * 60 * 60,  // series list
  POINTS_TABLE:  6 * 60 * 60,  // standings
  SQUADS:        24 * 60 * 60, // squad data
  PLAYERS:       24 * 60 * 60, // player list / search / profile
  USER:          5 * 60,       // user profile / favorites
  IPL_SERIES:    24 * 60 * 60, // resolved IPL series ID
  DAILY:         24 * 60 * 60, // generic 24 h TTL

  // Football — conservative TTLs to respect API-Football rate limits
  FOOTBALL_LIVE:     60,           // poll live scores every 60s
  FOOTBALL_FIXTURES: 30 * 60,      // upcoming fixtures (30 min)
  FOOTBALL_RESULTS:  60 * 60,      // completed results (1h)
  FOOTBALL_GROUPS:   60 * 60,      // group standings (1h)
  FOOTBALL_MATCH:    5 * 60,       // single match detail (5 min)
  FOOTBALL_TIP:      24 * 60 * 60, // predictions survive restarts (24h)
  FOOTBALL_H2H:      24 * 60 * 60, // H2H records rarely change
  FOOTBALL_TEAM:     6 * 60 * 60,  // team stats (6h)

  // International bilateral series (generic T20I bucket grouped by stage)
  INTL_SERIES:       6 * 60 * 60,  // series list / detail (6h, mirrors SERIES)
  INTL_HISTORY:      24 * 60 * 60, // all-time H2H + recent form (slow-changing)
};

// ── Cache keys ────────────────────────────────────────────────

const KEYS = {
  // Match
  ALL_MATCHES:      "matches:all",
  LIVE_MATCHES:     "matches:live",
  MATCH_DETAIL:     (id) => `match:detail:${id}`,
  MATCH_SQUAD:      (id) => `match:squad:${id}`,
  MATCH_FULL:       (id) => `match:full:${id}`,
  MATCH_SCORECARD:  (id) => `match:scorecard:${id}`,

  // Series
  SERIES_LIST:      "series:list",
  SERIES_DETAIL:    (id) => `series:detail:${id}`,  // match list only (liveService)
  SERIES_TABLE:     (id) => `series:table:${id}`,
  SERIES_INFO:      (id) => `series:info:${id}`,    // full series detail (id + matches + table)

  // Players
  PLAYER_LIST:      "players:list",
  PLAYER_SEARCH:    (q)  => `players:search:${q.toLowerCase().trim()}`,
  PLAYER_INFO:      (id) => `player:info:${id}`,

  // User
  USER_PROFILE:     (uid) => `user:profile:${uid}`,
  USER_FAVORITES:   (uid) => `user:favorites:${uid}`,

  // IPL (legacy keys — kept for iplService backward compat)
  IPL_SERIES_ID:  "ipl:series_id",
  IPL_FIXTURES:   "ipl:fixtures",
  IPL_TABLE:      "ipl:table",

  // Multi-league (keyed by slug)
  LEAGUE_FIXTURES: (slug) => `league:fixtures:${slug}`,
  LEAGUE_TABLE:    (slug) => `league:table:${slug}`,
  LEAGUE_LIVE:     (slug) => `league:live:${slug}`,

  // Football
  FOOTBALL_FIXTURES:  'football:fixtures',
  FOOTBALL_LIVE:      'football:live',
  FOOTBALL_GROUPS:    'football:groups',
  FOOTBALL_MATCH:     (id) => `football:match:${id}`,
  FOOTBALL_TIP:       (id) => `football:tip:${id}`,
  FOOTBALL_TIPS_LIST: 'football:tips:list',
  FOOTBALL_H2H:       (t1, t2) => `football:h2h:${[t1, t2].sort().join('-')}`,
  FOOTBALL_TEAM:      (id) => `football:team:${id}`,

  // International bilateral series
  INTL_SERIES_LIST:   (slug) => `intl:series:list:${slug}`,
  INTL_SERIES_DETAIL: (stageId) => `intl:series:detail:${stageId}`,
  INTL_H2H:           (t1, t2) => `intl:h2h:${[t1, t2].sort().join('-')}`,
  INTL_FORM:          (teamId) => `intl:form:${teamId}`,
};

// ── Cache instance ────────────────────────────────────────────

const cache = new NodeCache({
  stdTTL:      TTL.FIXTURES, // default fallback TTL
  checkperiod: 60,           // expired-key sweep interval (seconds)
  useClones:   false,        // return references for performance
});

// ── Public API ────────────────────────────────────────────────

function getCache(key) {
  const value = cache.get(key);
  return value !== undefined ? value : null;
}

function setCache(key, data, ttlSeconds) {
  cache.set(key, data, ttlSeconds);
}

function delCache(key) {
  cache.del(key);
}

function flushCache() {
  cache.flushAll();
  console.log("[Cache] flushed");
}

function getStats() {
  return cache.getStats();
}

module.exports = { getCache, setCache, delCache, flushCache, getStats, TTL, KEYS };
