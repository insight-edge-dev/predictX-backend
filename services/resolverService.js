/**
 * resolverService.js
 *
 * Two-phase bulletproof prediction resolution. Handles every sport, league, and
 * match in the system — including future ones not yet in any config file.
 *
 * Phase 1 (Proactive) — scans every configured match source using already-cached
 *   fixture lists. Zero new API calls; catches the vast majority of finished
 *   matches within 30 minutes of completion.
 *
 * Phase 2 (Reactive / Fallback) — queries the DB for ANY remaining pending
 *   predictions that Phase 1 missed, then looks them up directly. This is the
 *   safety net for: leagues not yet in config, expired fixture caches, future
 *   sport integrations, or any match whose sport column says something new.
 *
 * Call startResolver() once at server boot.
 * Call resolveMatch(matchId, winner) directly from the admin endpoint.
 */

const supabase       = require("../config/supabase");
const predSvc        = require("./userPredictionService");
const leagueSvc      = require("./leagueService");
const intlSvc        = require("./internationalService");
const footballSvc    = require("./footballService");
const footballAPI    = require("./footballAPIService");
const footballNorm   = require("./footballNormalizer");
const sm             = require("./sportmonksService");
const { normalizeFixture } = require("./sportmonksNormalizer");
const { LEAGUES }    = require("../config/leaguesConfig");
const { getCache, delCache, listEntries } = require("./cacheService");

const INTERVAL_MS          = 30 * 60 * 1000; // 30 minutes
const PHASE2_API_MAX       = 15;             // max direct Sportsmonks calls per run
const PHASE2_DELAY_MS      = 500;            // ms between direct Sportsmonks API calls
const FOOTBALL_API_DELAY_MS = 6500;          // football-data.org: 10 req/min free tier

// Track matches resolved this server session to skip repeat work
const _resolved = new Set();

// ── Helpers ───────────────────────────────────────────────────

async function _sendPredictionResultPush(matchId, winner) {
  if (winner === "void") return; // no-result matches don't have a meaningful push
  const { sendPushNotifications, getTokensForUsers } = require("./pushService");

  const { data: preds } = await supabase
    .from("user_match_predictions")
    .select("user_id, result")
    .eq("match_id", String(matchId))
    .not("result", "is", null);

  if (!preds?.length) return;

  const correct   = preds.filter(p => p.result === "correct").map(p => p.user_id);
  const incorrect = preds.filter(p => p.result === "incorrect").map(p => p.user_id);

  if (correct.length) {
    const tokens = await getTokensForUsers(correct, "prediction_results");
    if (tokens.length) {
      sendPushNotifications(
        tokens,
        "Correct Prediction!",
        `You got it right! Match won by ${winner}. Points added to your score.`,
        { type: "prediction_result", matchId: String(matchId) },
      );
    }
  }

  if (incorrect.length) {
    const tokens = await getTokensForUsers(incorrect, "prediction_results");
    if (tokens.length) {
      sendPushNotifications(
        tokens,
        "Match Result",
        `${winner} won the match. Better luck next time!`,
        { type: "prediction_result", matchId: String(matchId) },
      );
    }
  }
}

function _bustLeaderboardCache() {
  const entries = listEntries ? listEntries() : [];
  for (const entry of entries) {
    if (entry.key.startsWith("leaderboard:")) delCache(entry.key);
  }
}

// Translate football-data.org winner token → actual team name (lowercase "draw" matches stored predicted_winner)
function _footballWinner(match) {
  const w = match.score?.winner;
  if (w === "HOME_TEAM") return match.homeTeam?.name ?? null;
  if (w === "AWAY_TEAM") return match.awayTeam?.name ?? null;
  if (w === "DRAW")      return "draw";

  // Score-based fallback for completed matches where winner field is absent
  if (match.status !== "completed") return null;
  const home = match.score?.home;
  const away = match.score?.away;
  if (home == null || away == null) return null;
  if (home > away) return match.homeTeam?.name ?? null;
  if (away > home) return match.awayTeam?.name ?? null;
  return "draw";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Core resolution ───────────────────────────────────────────

async function resolveMatch(matchId, actualWinner) {
  const id     = String(matchId);
  const result = actualWinner === "No Result" || actualWinner === "void"
    ? "void"
    : actualWinner;

  // Skip immediately if no pending predictions exist
  const { data: pending } = await supabase
    .from("user_match_predictions")
    .select("id")
    .eq("match_id", id)
    .is("result", null)
    .limit(1);

  if (!pending?.length) {
    _resolved.add(id);
    return { resolved: 0, matchId: id, winner: result };
  }

  await predSvc.resolvePredictions(id, result);
  _resolved.add(id);
  _bustLeaderboardCache();

  // Fire prediction result push notifications (non-blocking)
  _sendPredictionResultPush(id, result).catch(e =>
    console.warn("[Resolver] push notification error:", e.message),
  );

  console.log(`[Resolver] ✓ match ${id} resolved as "${result}"`);
  return { resolved: pending.length, matchId: id, winner: result };
}

// ── Phase 1: scan every configured match source ───────────────

async function _phase1() {
  let count = 0;

  // ── 1a. All configured cricket leagues ──────────────────────
  // Covers IPL, BBL, PSL, BPL, T20WC, WWCT20, GSL, CSA T20,
  // Super Smash, Ashes, T20 Blast, T20 Mumbai, IML, ECS Portugal, Tri-Series
  for (const league of Object.values(LEAGUES)) {
    try {
      const { completed } = await leagueSvc.getLeagueMatches(league);
      for (const match of completed) {
        const id = String(match.id);
        if (_resolved.has(id) || !match.winner) continue;
        const r = await resolveMatch(id, match.winner);
        if (r.resolved > 0) count++;
      }
    } catch (e) {
      console.warn(`[Resolver] P1 league ${league.slug}:`, e.message);
    }
  }

  // ── 1b. International bilateral cricket buckets ──────────────
  // Covers ALL bilateral formats — auto-discovered from Sportsmonks daily
  for (const bucket of await intlSvc.getActiveBuckets()) {
    try {
      const fixtures = await intlSvc.getBucketFixtures(bucket);
      for (const match of fixtures) {
        if (!match.winner) continue;
        const id = String(match.id);
        if (_resolved.has(id)) continue;
        const r = await resolveMatch(id, match.winner);
        if (r.resolved > 0) count++;
      }
    } catch (e) {
      console.warn(`[Resolver] P1 intl ${bucket.slug}:`, e.message);
    }
  }

  // ── 1c. Football (FIFA World Cup 2026) ───────────────────────
  try {
    const { completed } = await footballSvc.getMatches();
    for (const match of completed) {
      const id = String(match.id);
      if (_resolved.has(id)) continue;
      const winner = _footballWinner(match);
      if (!winner) continue;
      const r = await resolveMatch(id, winner);
      if (r.resolved > 0) count++;
    }
  } catch (e) {
    console.warn("[Resolver] P1 football:", e.message);
  }

  return count;
}

// ── Phase 2: DB-driven fallback ───────────────────────────────
// Catches anything Phase 1 missed by starting from the predictions table
// itself and looking up each unresolved match_id directly. This guarantees
// coverage even for leagues not in config, future sports, or stale caches.

async function _phase2() {
  let count = 0;

  const { data: rows, error } = await supabase
    .from("user_match_predictions")
    .select("match_id, sport")
    .is("result", null);

  if (error || !rows?.length) return 0;

  // One entry per match_id — keep first sport value seen
  const pending = new Map();
  for (const row of rows) {
    const id = String(row.match_id);
    if (!_resolved.has(id) && !pending.has(id)) {
      pending.set(id, (row.sport ?? "cricket").toLowerCase());
    }
  }

  if (pending.size === 0) return 0;
  console.log(`[Resolver] P2 checking ${pending.size} match(es) still pending`);

  let apiCalls = 0;

  for (const [id, sport] of pending.entries()) {
    try {
      let winner = null;

      if (sport === "football") {
        // Try NodeCache/Supabase first (free, no rate-limit)
        const match = await footballSvc.getMatchById(id);
        if (match) winner = _footballWinner(match);

        // Fallback: direct API call — mirrors cricket's Phase 2 approach.
        // Handles knockout stage matches not yet synced to cache, and old
        // cached fixtures that pre-date the score.winner normalizer fix.
        if (!winner) {
          const numId = parseInt(id, 10);
          if (!isNaN(numId)) {
            console.log(`[Resolver] P2 football ${id}: cache miss — calling API directly`);
            const raw = await footballAPI.getMatchDetail(numId);
            if (raw) winner = _footballWinner(footballNorm.normalizeFixture(raw));
            await sleep(FOOTBALL_API_DELAY_MS);
          }
        }

      } else {
        // Cricket — check NodeCache layers first before any API call
        const cached =
          getCache(`completed_match:${id}`) ??
          getCache(`match:basic:${id}`);

        if (cached?.winner) {
          winner = cached.winner;
        } else if (apiCalls < PHASE2_API_MAX) {
          // Last resort: direct Sportsmonks fixture-detail call
          apiCalls++;
          const raw = await sm.getFixtureDetail(Number(id));
          if (raw) {
            const norm = normalizeFixture(raw);
            if (norm?.winner) winner = norm.winner;
          }
          // Rate-limit guard — don't burst more than 2 req/s
          if (apiCalls < PHASE2_API_MAX) await sleep(PHASE2_DELAY_MS);
        }
      }

      if (!winner) continue;

      const r = await resolveMatch(id, winner);
      if (r.resolved > 0) {
        count++;
        console.log(`[Resolver] P2 caught match ${id} (${sport}) → "${winner}"`);
      }

    } catch (e) {
      console.warn(`[Resolver] P2 match ${id}:`, e.message);
    }
  }

  return count;
}

// ── Orchestrator ──────────────────────────────────────────────

async function runAutoResolve() {
  try {
    const p1 = await _phase1();
    const p2 = await _phase2();
    const total = p1 + p2;
    if (total > 0) {
      console.log(`[Resolver] pass complete — ${p1} from scan, ${p2} from fallback`);
    } else {
      console.log(`[Resolver] pass complete — nothing new to resolve`);
    }
    return total;
  } catch (e) {
    console.error("[Resolver] runAutoResolve error:", e.message);
    return 0;
  }
}

function startResolver() {
  runAutoResolve();
  setInterval(runAutoResolve, INTERVAL_MS);
  console.log(`[Resolver] started — checking every ${INTERVAL_MS / 60_000} min`);
}

module.exports = { startResolver, runAutoResolve, resolveMatch };
