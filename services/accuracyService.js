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
const sm = require("./sportmonksService");
const { getPersistentLightTip } = require("./lightTipService");

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

// ── Per-match row shaping (shared by the league-cards feature below) ──────

function buildRows(matches, predictionsMap, resolver, keyPrefix, toRow) {
  const rows = [];
  for (const m of matches) {
    const pred = predictionsMap.get(`${keyPrefix}${m.id}`);
    if (!pred) continue;
    const result = resolver(pred.winner, m);
    if (result === null) continue;
    rows.push(toRow(m, pred.winner, result === "correct"));
  }
  return rows;
}

function cricketRow(leagueLabel) {
  return (m, predictedWinner, isCorrect) => ({
    id: m.id, sport: "cricket", leagueLabel, date: m.date,
    team1: { name: m.team1?.name, shortName: m.team1?.shortName, logo: m.team1?.logo, score: m.score1 ?? null, overs: m.overs1 ?? null },
    team2: { name: m.team2?.name, shortName: m.team2?.shortName, logo: m.team2?.logo, score: m.score2 ?? null, overs: m.overs2 ?? null },
    predictedWinner, actualResult: m.winner, resultText: m.statusText ?? null, isCorrect, isUpcoming: false,
  });
}

function footballRow(leagueLabel) {
  return (m, predictedWinner, isCorrect) => ({
    id: m.id, sport: "football", leagueLabel, date: m.date,
    team1: { name: m.homeTeam?.name, shortName: m.homeTeam?.shortName, logo: m.homeTeam?.logo, score: m.score?.home ?? null, overs: null },
    team2: { name: m.awayTeam?.name, shortName: m.awayTeam?.shortName, logo: m.awayTeam?.logo, score: m.score?.away ?? null, overs: null },
    predictedWinner, actualResult: `${m.score?.home}–${m.score?.away}`, resultText: null, isCorrect, isUpcoming: false,
  });
}

function sortByDateDesc(rows) {
  return [...rows].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

// ── Per-league prediction track record (Discovery "PredictX Prediction" cards) ──
// One card per league/bucket/football — its own accuracy (override-aware, same
// figure shown elsewhere for that league), plus either:
//   - a completed tournament (its Final has been played): the Final + previous matches
//   - an ongoing tournament: the next upcoming match (with our pick) + recent results

async function getLeagueImageMap() {
  try {
    const rawLeagues = await sm.getAllLeagues();
    const map = new Map();
    if (Array.isArray(rawLeagues)) {
      for (const l of rawLeagues) map.set(l.id, l.image_path ?? "");
    }
    return map;
  } catch (e) {
    console.warn("[Accuracy] league cards: logo lookup failed:", e.message);
    return new Map();
  }
}

function buildUpcomingRow(match, predictionsMap, keyPrefix, rowBuilder) {
  if (!match) return null;
  const pred = predictionsMap.get(`${keyPrefix}${match.id}`);
  if (!pred) return null;
  return { ...rowBuilder(match, pred.winner, null), isUpcoming: true, actualResult: null, resultText: null };
}

// IPL predictions are generated lazily (only when a user opens that match) —
// every other cricket scope is covered proactively by predictionSchedulerService,
// so this on-demand generation is needed for IPL alone.
async function ensureUpcomingPrediction(slug, match, predictionsMap, keyPrefix) {
  if (!match || slug !== "ipl") return;
  const key = `${keyPrefix}${match.id}`;
  if (predictionsMap.has(key)) return;
  try {
    const tip = await getPersistentLightTip(match, { isIPL: true });
    if (tip) predictionsMap.set(key, tip);
  } catch (e) {
    console.warn(`[Accuracy] league cards: on-demand IPL tip for match ${match.id} failed:`, e.message);
  }
}

function selectCardRows(seasonOver, finalMatchId, upcomingRow, rows, cap) {
  if (seasonOver) {
    const finalRow = finalMatchId != null ? rows.find(r => r.id === finalMatchId) : null;
    if (finalRow) {
      const rest = rows.filter(r => r.id !== finalMatchId).slice(0, cap - 1);
      return [finalRow, ...rest];
    }
    return rows.slice(0, cap);
  }
  const recents = rows.slice(0, cap - (upcomingRow ? 1 : 0));
  return upcomingRow ? [upcomingRow, ...recents] : recents;
}

async function getCardSettingsMap() {
  try {
    const { data, error } = await supabase.from("league_card_settings").select("*");
    if (error) throw new Error(error.message);
    return new Map((data ?? []).map(s => [s.slug, s]));
  } catch (e) {
    console.warn("[Accuracy] league cards: settings lookup failed:", e.message);
    return new Map();
  }
}

async function computeLeagueCards(perLeagueLimit = 5) {
  const [cricketPredictions, footballPredictions, leagueImages, cardSettings] = await Promise.all([
    db.getCachedDataByPrefix("pred:light:"),
    db.getCachedDataByPrefix("football:tip:"),
    getLeagueImageMap(),
    getCardSettingsMap(),
  ]);

  // Pre-assign natural order sequentially so orderMap is stable
  // regardless of parallel fetch completion order below.
  let naturalIndex = 0;
  const orderMap = new Map();
  const allSlugs = [
    ...Object.values(LEAGUES).map(l => l.slug),
    ...Object.values(FOOTBALL_LEAGUES).map(l => l.slug),
    ...Object.values(internationalService.INTERNATIONAL_LEAGUES).map(b => b.slug),
  ];
  for (const slug of allSlugs) {
    const s = cardSettings.get(slug);
    orderMap.set(slug, s ? s.display_order : naturalIndex);
    naturalIndex++;
  }
  function isCardVisible(slug) {
    const s = cardSettings.get(slug);
    return s ? s.is_visible !== false : true;
  }

  // ── Fetch all three league types in parallel ──────────────────

  const [cricketCards, footballCards, intlCards] = await Promise.all([

    Promise.all(Object.values(LEAGUES).filter(l => isCardVisible(l.slug)).map(async league => {
      try {
        const { upcoming } = await leagueService.getLeagueMatches(league);
        if (upcoming.length === 0) return null;

        await ensureUpcomingPrediction(league.slug, upcoming[0], cricketPredictions, "pred:light:");
        const upcomingRow = buildUpcomingRow(upcoming[0], cricketPredictions, "pred:light:", cricketRow(league.short));

        return {
          slug: league.slug, name: league.name, season: league.season, flag: league.flag,
          short: league.short, image: leagueImages.get(league.leagueId) || "", sport: "cricket",
          accuracy: await getLeagueAccuracyPublic(league.slug),
          recentMatches: upcomingRow ? [upcomingRow] : [],
        };
      } catch (e) {
        console.warn(`[Accuracy] league cards: cricket ${league.slug} failed:`, e.message);
        return null;
      }
    })),

    Promise.all(Object.values(FOOTBALL_LEAGUES).filter(l => isCardVisible(l.slug)).map(async footballLeague => {
      try {
        const { upcoming } = await footballService.getMatches();
        if (upcoming.length === 0) return null;

        const upcomingRow = buildUpcomingRow(upcoming[0], footballPredictions, "football:tip:", footballRow(footballLeague.short));

        return {
          slug: footballLeague.slug, name: footballLeague.name, season: footballLeague.season, flag: footballLeague.flag,
          short: footballLeague.short, image: footballLeague.image ?? "", sport: "football",
          accuracy: await getLeagueAccuracyPublic(footballLeague.slug),
          recentMatches: upcomingRow ? [upcomingRow] : [],
        };
      } catch (e) {
        console.warn(`[Accuracy] league cards: football ${footballLeague.slug} failed:`, e.message);
        return null;
      }
    })),

    Promise.all(Object.values(internationalService.INTERNATIONAL_LEAGUES).filter(b => isCardVisible(b.slug)).map(async bucket => {
      try {
        const fixtures = await internationalService.getBucketFixtures(bucket);
        const upcoming = fixtures
          .filter(m => internationalService.effectiveStatus(m) === "upcoming")
          .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        if (upcoming.length === 0) return null;

        const upcomingRow = buildUpcomingRow(upcoming[0], cricketPredictions, "pred:light:", cricketRow(bucket.short));

        return {
          slug: bucket.slug, name: bucket.name, season: "International", flag: bucket.flag,
          short: bucket.short, image: leagueImages.get(bucket.leagueId) || "", sport: "cricket",
          accuracy: await getLeagueAccuracyPublic(bucket.slug),
          recentMatches: upcomingRow ? [upcomingRow] : [],
        };
      } catch (e) {
        console.warn(`[Accuracy] league cards: international ${bucket.slug} failed:`, e.message);
        return null;
      }
    })),

  ]);

  const cards = [...cricketCards, ...footballCards, ...intlCards].filter(Boolean);
  cards.sort((a, b) => (orderMap.get(a.slug) ?? 0) - (orderMap.get(b.slug) ?? 0));
  return cards;
}

async function getLeagueCardsPublic(limit = 5) {
  const cacheKey = `accuracy:league-cards:${limit}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  const result = await computeLeagueCards(limit);
  // If predictions weren't available (e.g. Supabase contention at boot), don't
  // lock the empty result for a full hour — retry in 30 s so the section
  // populates as soon as the DB settles.
  const hasData = result.some(c => (c.accuracy?.sampleSize ?? 0) > 0 || c.recentMatches?.length > 0);
  setCache(cacheKey, result, hasData ? ACCURACY_TTL_S : 30);
  return result;
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
  getLeagueCardsPublic,
  setOverride,
};
