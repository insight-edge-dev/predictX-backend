/**
 * accuracyService.js — real "prediction accuracy %" computed by comparing
 * every completed match's stored PredictX prediction against the actual
 * result, aggregated globally and per-league/bucket.
 *
 * The correctness comparison logic is a deliberate port of the frontend's
 * resolveCricketTipResult/resolveFootballTipResult
 * (frontend/src/app/(tabs)/(tips)/index.tsx) — kept in sync so the aggregate
 * stat agrees with the ✓/✗ badges users see on individual predictions.
 */

const supabase = require("../config/supabase");
const db = require("./dbService");
const { getCache, setCache } = require("./cacheService");
const { LEAGUES, FOOTBALL_LEAGUES } = require("../config/leaguesConfig");
const leagueService = require("./leagueService");
const footballService = require("./footballService");
const internationalService = require("./internationalService");

const ACCURACY_TTL_S = 60 * 60; // 1h — match outcomes don't change retroactively

// ── Correctness resolvers (ported from the frontend, kept identical) ──────

function resolveCricketResult(predictedWinner, match) {
  const actualWinner = match?.winner;
  if (!actualWinner || !predictedWinner || actualWinner === "No Result") return null;

  const predicted = predictedWinner.toLowerCase().trim();
  const t1s = (match.team1?.shortName ?? "").toLowerCase();
  const t2s = (match.team2?.shortName ?? "").toLowerCase();
  const t1n = (match.team1?.name ?? "").toLowerCase();
  const t2n = (match.team2?.name ?? "").toLowerCase();
  const actual = actualWinner.toLowerCase();

  const predictedT1 =
    predicted === t1s || predicted === t1n ||
    t1n.startsWith(predicted) || predicted.startsWith(t1s) ||
    predicted.includes(t1n) || predicted.includes(` ${t1s}`) || predicted.endsWith(`(${t1s})`);
  const predictedT2 =
    predicted === t2s || predicted === t2n ||
    t2n.startsWith(predicted) || predicted.startsWith(t2s) ||
    predicted.includes(t2n) || predicted.includes(` ${t2s}`) || predicted.endsWith(`(${t2s})`);

  if (!predictedT1 && !predictedT2) return null;
  const team1Won = actual.includes(t1s) ||
    t1n.split(" ").some(w => w.length > 2 && actual.includes(w));
  if (predictedT1) return team1Won ? "correct" : "wrong";
  return team1Won ? "wrong" : "correct";
}

function resolveFootballResult(predictedWinner, match) {
  const home = match?.score?.home;
  const away = match?.score?.away;
  if (!predictedWinner || home == null || away == null) return null;

  const predicted = predictedWinner.toLowerCase().trim();
  const homeShort = (match.homeTeam?.shortName ?? "").toLowerCase();
  const awayShort = (match.awayTeam?.shortName ?? "").toLowerCase();
  const homeName  = (match.homeTeam?.name ?? "").toLowerCase();
  const awayName  = (match.awayTeam?.name ?? "").toLowerCase();

  const predictedHome =
    predicted === homeShort || predicted === homeName ||
    homeName.startsWith(predicted) || predicted.startsWith(homeShort) || predicted.includes(homeName);
  const predictedAway =
    predicted === awayShort || predicted === awayName ||
    awayName.startsWith(predicted) || predicted.startsWith(awayShort) || predicted.includes(awayName);
  const predictedDraw = predicted === "draw" || predicted === "tie";

  if (!predictedHome && !predictedAway && !predictedDraw) return null;
  if (home === away) return predictedDraw ? "correct" : "wrong";

  const homeWon = home > away;
  if (predictedDraw) return "wrong";
  if (predictedHome) return homeWon ? "correct" : "wrong";
  return homeWon ? "wrong" : "correct";
}

// ── Tally helper ───────────────────────────────────────────────

function tally(matches, predictionsMap, resolver, keyPrefix) {
  let correct = 0, total = 0;
  for (const m of matches) {
    const pred = predictionsMap.get(`${keyPrefix}${m.id}`);
    if (!pred) continue;
    const result = resolver(pred.winner, m);
    if (result === null) continue;
    total++;
    if (result === "correct") correct++;
  }
  return { correct, total };
}

// ── Per-scope computation ──────────────────────────────────────
// `cricketPredictions`/`footballPredictions` are accepted as params (rather
// than each fetched internally) so a global computation across many
// leagues/buckets fetches each prediction set from Supabase exactly once.

async function computeCricketLeagueTally(league, cricketPredictions) {
  const { completed } = await leagueService.getLeagueMatches(league);
  return tally(completed, cricketPredictions, resolveCricketResult, "pred:light:");
}

async function computeFootballTally(footballPredictions) {
  const { completed } = await footballService.getMatches();
  return tally(completed, footballPredictions, resolveFootballResult, "football:tip:");
}

async function computeInternationalBucketTally(bucket, cricketPredictions) {
  const fixtures = await internationalService.getBucketFixtures(bucket);
  const completed = fixtures.filter(m => internationalService.effectiveStatus(m) === "completed");
  return tally(completed, cricketPredictions, resolveCricketResult, "pred:light:");
}

function toPercentage(t) {
  return { correct: t.correct, total: t.total, percentage: t.total > 0 ? Math.round((t.correct / t.total) * 100) : 0 };
}

async function computeLeagueAccuracy(slug) {
  if (LEAGUES[slug]) {
    const predictions = await db.getCachedDataByPrefix("pred:light:");
    return toPercentage(await computeCricketLeagueTally(LEAGUES[slug], predictions));
  }
  if (FOOTBALL_LEAGUES[slug]) {
    const predictions = await db.getCachedDataByPrefix("football:tip:");
    return toPercentage(await computeFootballTally(predictions));
  }
  const bucket = internationalService.INTERNATIONAL_LEAGUES[slug];
  if (bucket) {
    const predictions = await db.getCachedDataByPrefix("pred:light:");
    return toPercentage(await computeInternationalBucketTally(bucket, predictions));
  }
  return null;
}

async function computeGlobalAccuracy() {
  let correct = 0, total = 0;

  const [cricketPredictions, footballPredictions] = await Promise.all([
    db.getCachedDataByPrefix("pred:light:"),
    db.getCachedDataByPrefix("football:tip:"),
  ]);

  for (const league of Object.values(LEAGUES)) {
    try {
      const t = await computeCricketLeagueTally(league, cricketPredictions);
      correct += t.correct; total += t.total;
    } catch (e) {
      console.warn(`[Accuracy] cricket league ${league.slug} failed:`, e.message);
    }
  }

  if (Object.keys(FOOTBALL_LEAGUES).length > 0) {
    try {
      const t = await computeFootballTally(footballPredictions);
      correct += t.correct; total += t.total;
    } catch (e) {
      console.warn("[Accuracy] football failed:", e.message);
    }
  }

  for (const bucket of Object.values(internationalService.INTERNATIONAL_LEAGUES)) {
    try {
      const t = await computeInternationalBucketTally(bucket, cricketPredictions);
      correct += t.correct; total += t.total;
    } catch (e) {
      console.warn(`[Accuracy] international ${bucket.slug} failed:`, e.message);
    }
  }

  return toPercentage({ correct, total });
}

// ── Cached entry points ─────────────────────────────────────────

async function getCachedLeagueAccuracy(slug) {
  const cacheKey = `accuracy:league:${slug}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  const result = await computeLeagueAccuracy(slug);
  if (result) setCache(cacheKey, result, ACCURACY_TTL_S);
  return result;
}

async function getCachedGlobalAccuracy() {
  const cacheKey = "accuracy:global";
  const cached = getCache(cacheKey);
  if (cached) return cached;
  const result = await computeGlobalAccuracy();
  setCache(cacheKey, result, ACCURACY_TTL_S);
  return result;
}

// ── Admin override layer ────────────────────────────────────────

async function getOverride(key) {
  const { data, error } = await supabase
    .from("accuracy_overrides")
    .select("override_pct")
    .eq("key", key)
    .single();
  if (error || !data) return null;
  return data.override_pct;
}

async function getAccuracyWithOverride(key, computeFn) {
  const computed = await computeFn();
  if (!computed) return null;
  const override = await getOverride(key);
  const hasOverride = override !== null && override !== undefined;
  return {
    percentage: hasOverride ? Number(override) : computed.percentage,
    sampleSize: computed.total,
    isOverridden: hasOverride,
    computedPercentage: computed.percentage,
  };
}

async function getGlobalAccuracyPublic() {
  return getAccuracyWithOverride("global", getCachedGlobalAccuracy);
}

async function getLeagueAccuracyPublic(slug) {
  return getAccuracyWithOverride(slug, () => getCachedLeagueAccuracy(slug));
}

async function setOverride(key, overridePct) {
  if (overridePct === null) {
    const { error } = await supabase.from("accuracy_overrides").delete().eq("key", key);
    if (error) throw new Error(error.message);
    return;
  }
  const { error } = await supabase
    .from("accuracy_overrides")
    .upsert({ key, override_pct: overridePct, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

module.exports = {
  resolveCricketResult,
  resolveFootballResult,
  computeLeagueAccuracy,
  computeGlobalAccuracy,
  getGlobalAccuracyPublic,
  getLeagueAccuracyPublic,
  setOverride,
};
