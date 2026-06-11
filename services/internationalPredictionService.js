/**
 * internationalPredictionService.js — prediction engine for bilateral
 * international series (no shared league table to lean on, unlike
 * genericTipsService's franchise-league model).
 *
 * Deterministic 2-way scoring. Factors:
 *   1. All-time Head-to-Head (this format)        45%
 *   2. Recent international form (last 5, any opp) 35%
 *   3. In-series Head-to-Head (this tour so far)   20% — only when decided > 0
 *
 * Output shape mirrors genericTipsService so the existing MatchCard /
 * ProbabilityBar / prediction-detail UI render unchanged.
 */

const sm = require("./sportmonksService");
const { normalizeFixture } = require("./sportmonksNormalizer");
const { getCache, setCache, TTL, KEYS } = require("./cacheService");

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// Same hash approach as genericTipsService/footballPredictionService — same
// matchup always yields the same split; different matchups differ.
function seededVariance(seed, range) {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(h, 33) ^ seed.charCodeAt(i)) >>> 0;
  }
  return (h % (range * 2 + 1)) - range;
}

function pairNorm(a, b) {
  const tot = a + b;
  return tot > 0 ? [a / tot, b / tot] : [0.5, 0.5];
}

// Knockout fixtures sometimes get TBC/TBD placeholder stubs before the
// qualifying matches that decide who plays in them — same guard as
// genericTipsService/tipsService/footballPredictionService.
function isPlaceholderTeam(team) {
  const name = (team?.shortName || team?.name || "").toUpperCase();
  return name === "TBC" || name === "TBD";
}

const EMPTY_TOP_PERFORMERS = { battersVsT2: [], battersVsT1: [], bowlersVsT2: [], bowlersVsT1: [] };
const EMPTY_STRENGTH       = { batAvgScore: null, batAvgSR: null, bowlEconomy: null, bowlWpm: null };

// ── Record builders ───────────────────────────────────────────

function matchWinnerName(m) {
  if (!m?.winner || m.winner === "No Result") return null;
  return m.winner;
}

// All-time head-to-head between two teams (by name) across raw fixtures.
function buildH2HRecord(rawFixtures, teamAName, teamBName) {
  const matches = (rawFixtures || []).map(normalizeFixture).filter(Boolean);
  let aWins = 0, bWins = 0, noResult = 0;
  const recent = [];
  for (const m of matches) {
    if (m.status !== "completed" && !m.winner) continue;
    const w = matchWinnerName(m);
    if (w === teamAName) aWins++;
    else if (w === teamBName) bWins++;
    else if (m.status === "completed") noResult++;
    else continue;
    recent.push({ date: m.date, home: m.team1?.shortName, away: m.team2?.shortName, scoreHome: m.score1, scoreAway: m.score2, winner: w });
  }
  return { total: aWins + bWins + noResult, aWins, bWins, noResult, recent: recent.slice(0, 5) };
}

// Recency-weighted form score (0-1) + W/L/N array (most recent first) from a
// team's last N fixtures (any opponent), mirrors genericTipsService.formScore.
function buildFormRecord(rawFixtures, teamId) {
  const matches = (rawFixtures || [])
    .map(normalizeFixture)
    .filter(Boolean)
    .filter(m => m.status === "completed")
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 5);

  const results = matches.map(m => {
    const isLocal = String(m.team1?.id) === String(teamId);
    const teamName = isLocal ? m.team1?.name : m.team2?.name;
    const w = matchWinnerName(m);
    if (!w) return "N";
    return w === teamName ? "W" : "L";
  });

  let weighted = 0, max = 0;
  results.forEach((c, i) => {
    const w = results.length - i;
    max += w;
    if (c === "W") weighted += w;
    else if (c === "N") weighted += w * 0.5;
  });

  return {
    score: max > 0 ? weighted / max : 0.5,
    results,
  };
}

function inSeriesH2H(completed, t1Name, t2Name) {
  let t1Wins = 0, t2Wins = 0, noResult = 0;
  for (const m of completed || []) {
    const w = matchWinnerName(m);
    if (w === t1Name) t1Wins++;
    else if (w === t2Name) t2Wins++;
    else noResult++;
  }
  return { total: t1Wins + t2Wins + noResult, t1Wins, t2Wins, noResult };
}

// ── Cached fetchers ────────────────────────────────────────────

async function getH2HRecord(leagueId, teamA, teamB) {
  const cacheKey = KEYS.INTL_H2H(String(teamA.id), String(teamB.id));
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const raw = await sm.getFixturesBetweenTeams(leagueId, teamA.id, teamB.id);
  const record = buildH2HRecord(raw, teamA.name, teamB.name);
  setCache(cacheKey, record, TTL.INTL_HISTORY);
  return record;
}

async function getFormRecord(leagueId, team) {
  const cacheKey = KEYS.INTL_FORM(String(team.id));
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const raw = await sm.getTeamRecentFixtures(leagueId, team.id);
  const record = buildFormRecord(raw, team.id);
  setCache(cacheKey, record, TTL.INTL_HISTORY);
  return record;
}

// ── Core prediction builder ───────────────────────────────────

async function buildPrediction(match, completed, leagueId) {
  const t1 = match.team1, t2 = match.team2;
  const t1Name = t1?.shortName || t1?.name;
  const t2Name = t2?.shortName || t2?.name;

  const [h2h, t1Form, t2Form] = await Promise.all([
    getH2HRecord(leagueId, t1, t2),
    getFormRecord(leagueId, t1),
    getFormRecord(leagueId, t2),
  ]);

  const seriesH2H  = inSeriesH2H(completed, t1Name, t2Name);
  const h2hDecided = h2h.aWins + h2h.bWins;

  const [h2hT1, h2hT2]   = pairNorm(h2h.aWins, h2h.bWins);
  const [formT1, formT2] = pairNorm(t1Form.score, t2Form.score);

  let t1Score, t2Score;
  if (seriesH2H.total > 0 && (seriesH2H.t1Wins + seriesH2H.t2Wins) > 0) {
    const decided = seriesH2H.t1Wins + seriesH2H.t2Wins;
    const [seriesT1, seriesT2] = pairNorm(seriesH2H.t1Wins, seriesH2H.t2Wins);
    const W = h2hDecided > 0
      ? { h2h: 0.40, form: 0.35, series: 0.25 }
      : { h2h: 0.20, form: 0.45, series: 0.35 }; // little all-time h2h — lean on form + this tour
    t1Score = W.h2h * h2hT1 + W.form * formT1 + W.series * seriesT1;
    t2Score = W.h2h * h2hT2 + W.form * formT2 + W.series * seriesT2;
  } else if (h2hDecided > 0) {
    const W = { h2h: 0.45, form: 0.55 };
    t1Score = W.h2h * h2hT1 + W.form * formT1;
    t2Score = W.h2h * h2hT2 + W.form * formT2;
  } else {
    // No history at all (e.g. associate nations meeting for the first time) —
    // lean entirely on recent form.
    t1Score = formT1;
    t2Score = formT2;
  }

  const total = t1Score + t2Score;
  let t1Pct = Math.round((t1Score / total) * 100);

  // No signal differentiates the teams — break the tie deterministically.
  if (Math.abs(t1Score - t2Score) < 0.001) {
    t1Pct = 50 + seededVariance(`${match.id}:${t1Name}:${t2Name}`, 6);
  }

  t1Pct = Math.max(25, Math.min(75, t1Pct));
  const t2Pct = 100 - t1Pct;

  const winner          = t1Pct >= t2Pct ? t1Name : t2Name;
  const confidence      = Math.max(t1Pct, t2Pct);
  const confidenceLabel = confidence >= 65 ? "HIGH" : confidence >= 55 ? "MEDIUM" : "LOW";

  // ── Factors (for detail page) ──────────────────────────────
  const factors = [];

  factors.push({
    label:      "Head to Head (all-time)",
    team1Value: h2hDecided > 0 ? `${h2h.aWins}/${h2hDecided} wins` : "No prior meetings",
    team2Value: h2hDecided > 0 ? `${h2h.bWins}/${h2hDecided} wins` : "No prior meetings",
    advantage:  h2h.aWins > h2h.bWins ? "team1" : h2h.bWins > h2h.aWins ? "team2" : "neutral",
  });

  factors.push({
    label:      "Recent International Form",
    team1Value: t1Form.results.length ? t1Form.results.join("") : "No data",
    team2Value: t2Form.results.length ? t2Form.results.join("") : "No data",
    advantage:  t1Form.score > t2Form.score + 0.05 ? "team1" : t2Form.score > t1Form.score + 0.05 ? "team2" : "neutral",
  });

  if (seriesH2H.total > 0) {
    factors.push({
      label:      "Head to Head (this series)",
      team1Value: `${seriesH2H.t1Wins}/${seriesH2H.total} wins`,
      team2Value: `${seriesH2H.t2Wins}/${seriesH2H.total} wins`,
      advantage:  seriesH2H.t1Wins > seriesH2H.t2Wins ? "team1" : seriesH2H.t2Wins > seriesH2H.t1Wins ? "team2" : "neutral",
    });
  }

  const h2hData = h2hDecided > 0 ? {
    total:       h2hDecided,
    team1Wins:   h2h.aWins,
    team2Wins:   h2h.bWins,
    noResult:    h2h.noResult,
    team1WinPct: Math.round((h2h.aWins / h2hDecided) * 100),
    team2WinPct: Math.round((h2h.bWins / h2hDecided) * 100),
    recentResults: h2h.recent,
  } : null;

  const parseFormArray = (results) => results.map(r => ({ result: r }));

  return {
    team1Pct: t1Pct, team2Pct: t2Pct, winner, confidence, confidenceLabel,
    factors,
    venueInsights: null,
    h2hData,
    recentForm:   { team1: parseFormArray(t1Form.results), team2: parseFormArray(t2Form.results) },
    strengthData: { team1: EMPTY_STRENGTH, team2: EMPTY_STRENGTH },
    topPerformers: EMPTY_TOP_PERFORMERS,
  };
}

// ── Public API (mirrors genericTipsService) ───────────────────

async function getMatchTip(match, completed, leagueId) {
  if (!match?.team1?.shortName || !match?.team2?.shortName) return null;
  if (isPlaceholderTeam(match.team1) || isPlaceholderTeam(match.team2)) return null;
  try {
    return await buildPrediction(match, completed, leagueId);
  } catch (e) {
    console.error("[IntlTips] getMatchTip failed:", e.message);
    return null;
  }
}

async function getLightweightTip(match, completed, leagueId) {
  const full = await getMatchTip(match, completed, leagueId);
  if (!full) return null;
  return {
    team1Pct:        full.team1Pct,
    team2Pct:        full.team2Pct,
    winner:          full.winner,
    confidence:      full.confidence,
    confidenceLabel: full.confidenceLabel,
  };
}

module.exports = { getMatchTip, getLightweightTip };
