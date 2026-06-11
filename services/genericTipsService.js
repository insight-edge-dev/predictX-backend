/**
 * genericTipsService.js — PredictX prediction engine for non-IPL cricket leagues.
 *
 * IPL has 18 years of historical Supabase tables (ipl_h2h, ipl_team_batting,
 * ipl_venue_stats, etc.) that power tipsService's 7-factor model. Other cricket
 * leagues (BBL, PSL, BPL, T20 WC, GSL, CSA T20, T20 Blast) have no equivalent
 * tables, so this engine works only with data Sportsmonks already provides for
 * any league/season — the current points table and this season's results:
 *
 *   1. League Standing (current season win%)        — 40-55%
 *   2. Recent Form     (last 5 results, recency-weighted) — 35-45%
 *   3. Head-to-Head    (in-season meetings, when any exist) — 25%
 *
 * wwct20 is a special case: a quadrennial tournament, so "this season" is
 * almost always empty/sparse pre- and early-tournament. For that league we blend
 * in real 2014-2023 historical data (wwct20HistoryService, loaded from a local
 * CSV — team win-rates and head-to-head across 112 World Cup matches) on top of
 * the in-season score, see HIST_WEIGHT below.
 *
 * Output shape mirrors tipsService so the existing frontend renders it unchanged
 * (sections with no data — venue, topPerformers, multi-season form — are simply
 * omitted/empty, which the UI already handles gracefully for IPL too).
 */

const wwct20History = require("./wwct20HistoryService");

// How much cross-tournament historical signal (2014-2023) factors into the
// final wwct20 score, layered on top of the in-season score. Kept well under
// 50% so a strong in-season run can still outweigh historical baselines.
const HIST_WEIGHT = 0.35;

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// Deterministic hash-based variance — same approach as predictionService/
// footballPredictionService — used only to break exact ties (e.g. pre-tournament,
// when neither team has any current-season data and scores compute identically).
// Same matchup always yields the same split; different matchups differ.
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

function tableRow(table, teamShort) {
  return (table || []).find(r => r.teamShort === teamShort) ?? null;
}

function ratingScore(row) {
  if (!row || !row.played) return 0.5;
  return clamp01(row.wins / row.played);
}

// Recency-weighted W/L/N string, e.g. ['W','W','L','N','W'] (most recent first)
function formScore(row) {
  const last5 = row?.last5;
  if (!Array.isArray(last5) || last5.length === 0) return 0.5;
  let weighted = 0, max = 0;
  last5.forEach((c, i) => {
    const w = last5.length - i;
    max += w;
    if (c === "W") weighted += w;
    else if (c === "N") weighted += w * 0.5;
  });
  return max > 0 ? weighted / max : 0.5;
}

function matchWinner(m) {
  if (!m?.winner || m.winner === "No Result") return null;
  if (m.winner === m.team1?.name) return m.team1.shortName;
  if (m.winner === m.team2?.name) return m.team2.shortName;
  return null;
}

function inSeasonH2H(completed, t1, t2) {
  const meetings = (completed || []).filter(m => {
    const names = [m.team1?.shortName, m.team2?.shortName];
    return names.includes(t1) && names.includes(t2);
  });
  let t1Wins = 0, t2Wins = 0, noResult = 0;
  for (const m of meetings) {
    const w = matchWinner(m);
    if (w === t1) t1Wins++;
    else if (w === t2) t2Wins++;
    else noResult++;
  }
  return { total: meetings.length, t1Wins, t2Wins, noResult };
}

const EMPTY_TOP_PERFORMERS = { battersVsT2: [], battersVsT1: [], bowlersVsT2: [], bowlersVsT1: [] };
const EMPTY_STRENGTH       = { batAvgScore: null, batAvgSR: null, bowlEconomy: null, bowlWpm: null };

// ── Core prediction ───────────────────────────────────────────

function buildGenericPrediction(matchId, t1, t2, table, completed, leagueSlug, t1Name, t2Name) {
  const t1Row = tableRow(table, t1);
  const t2Row = tableRow(table, t2);

  const t1Rating = ratingScore(t1Row);
  const t2Rating = ratingScore(t2Row);
  const t1Form   = formScore(t1Row);
  const t2Form   = formScore(t2Row);
  const h2h      = inSeasonH2H(completed, t1, t2);
  const decided  = h2h.t1Wins + h2h.t2Wins;

  const [ratingT1, ratingT2] = pairNorm(t1Rating, t2Rating);
  const [formT1, formT2]     = pairNorm(t1Form, t2Form);

  let t1Score, t2Score;
  if (decided > 0) {
    const h2hT1Pct = h2h.t1Wins / decided;
    const h2hT2Pct = 1 - h2hT1Pct;
    const W = { rating: 0.40, form: 0.35, h2h: 0.25 };
    t1Score = W.rating * ratingT1 + W.form * formT1 + W.h2h * h2hT1Pct;
    t2Score = W.rating * ratingT2 + W.form * formT2 + W.h2h * h2hT2Pct;
  } else {
    const W = { rating: 0.55, form: 0.45 };
    t1Score = W.rating * ratingT1 + W.form * formT1;
    t2Score = W.rating * ratingT2 + W.form * formT2;
  }

  // ── wwct20: blend in real 2014-2023 historical data ───────────
  // A quadrennial tournament means "this season" is sparse-to-empty for almost
  // every match — the in-season score above is mostly neutral (0.5/0.5). Cross-
  // tournament team win-rates and head-to-head give a grounded baseline instead.
  let histRecord = null;
  if (leagueSlug === "wwct20" && t1Name && t2Name) {
    const t1Hist = wwct20History.getTeamRecord(t1Name);
    const t2Hist = wwct20History.getTeamRecord(t2Name);
    const h2hHist = wwct20History.getH2H(t1Name, t2Name);

    if (t1Hist || t2Hist || h2hHist) {
      const [histRatingT1, histRatingT2] = pairNorm(t1Hist?.winPct ?? 0.5, t2Hist?.winPct ?? 0.5);
      let histScore1 = histRatingT1, histScore2 = histRatingT2;

      const h2hDecided = (h2hHist?.aWins ?? 0) + (h2hHist?.bWins ?? 0);
      if (h2hDecided > 0) {
        const histH2HT1Pct = h2hHist.aWins / h2hDecided;
        histScore1 = 0.5 * histRatingT1 + 0.5 * histH2HT1Pct;
        histScore2 = 0.5 * histRatingT2 + 0.5 * (1 - histH2HT1Pct);
      }

      t1Score = (1 - HIST_WEIGHT) * t1Score + HIST_WEIGHT * histScore1;
      t2Score = (1 - HIST_WEIGHT) * t2Score + HIST_WEIGHT * histScore2;

      histRecord = { t1Hist, t2Hist, h2hHist, h2hDecided };
    }
  }

  const total = t1Score + t2Score;
  let t1Pct   = Math.round((t1Score / total) * 100);

  // No signal differentiates the teams (e.g. tournament hasn't started — both
  // sit at 0 played, no form, no h2h) — every match would otherwise show an
  // identical 50/50. Break the tie deterministically per matchup instead.
  if (Math.abs(t1Score - t2Score) < 0.001) {
    t1Pct = 50 + seededVariance(`${matchId}:${t1}:${t2}`, 6);
  }

  t1Pct       = Math.max(25, Math.min(75, t1Pct));
  const t2Pct = 100 - t1Pct;

  const winner          = t1Pct >= t2Pct ? t1 : t2;
  const confidence      = Math.max(t1Pct, t2Pct);
  const confidenceLabel = confidence >= 65 ? "HIGH" : confidence >= 55 ? "MEDIUM" : "LOW";

  // ── Factors (for detail page) ─────────────────────────────────
  const factors = [];

  factors.push({
    label:      "League Standing",
    team1Value: t1Row ? `${t1Row.wins}W ${t1Row.losses}L · ${t1Row.points} pts` : "No data yet",
    team2Value: t2Row ? `${t2Row.wins}W ${t2Row.losses}L · ${t2Row.points} pts` : "No data yet",
    advantage:  ratingT1 > ratingT2 + 0.05 ? "team1" : ratingT2 > ratingT1 + 0.05 ? "team2" : "neutral",
  });

  if ((t1Row?.last5?.length ?? 0) > 0 || (t2Row?.last5?.length ?? 0) > 0) {
    factors.push({
      label:      "Recent Form",
      team1Value: t1Row?.last5?.length ? t1Row.last5.join("") : "No data",
      team2Value: t2Row?.last5?.length ? t2Row.last5.join("") : "No data",
      advantage:  formT1 > formT2 + 0.05 ? "team1" : formT2 > formT1 + 0.05 ? "team2" : "neutral",
    });
  }

  if (h2h.total > 0) {
    factors.push({
      label:      "Head to Head (this season)",
      team1Value: `${h2h.t1Wins}/${h2h.total} wins`,
      team2Value: `${h2h.t2Wins}/${h2h.total} wins`,
      advantage:  h2h.t1Wins > h2h.t2Wins ? "team1" : h2h.t2Wins > h2h.t1Wins ? "team2" : "neutral",
    });
  }

  if (histRecord) {
    const { t1Hist, t2Hist, h2hHist, h2hDecided } = histRecord;
    if (t1Hist || t2Hist) {
      factors.push({
        label:      "World Cup Record (2014-2023)",
        team1Value: t1Hist ? `${t1Hist.wins}W ${t1Hist.losses}L · ${Math.round(t1Hist.winPct * 100)}% win rate` : "No history",
        team2Value: t2Hist ? `${t2Hist.wins}W ${t2Hist.losses}L · ${Math.round(t2Hist.winPct * 100)}% win rate` : "No history",
        advantage:  (t1Hist?.winPct ?? 0.5) > (t2Hist?.winPct ?? 0.5) + 0.05 ? "team1"
                  : (t2Hist?.winPct ?? 0.5) > (t1Hist?.winPct ?? 0.5) + 0.05 ? "team2" : "neutral",
      });
    }
    if (h2hHist && h2hHist.total > 0) {
      factors.push({
        label:      "Head to Head (World Cups, all-time)",
        team1Value: `${h2hHist.aWins}/${h2hHist.total} wins`,
        team2Value: `${h2hHist.bWins}/${h2hHist.total} wins`,
        advantage:  h2hHist.aWins > h2hHist.bWins ? "team1" : h2hHist.bWins > h2hHist.aWins ? "team2" : "neutral",
      });
    }
  }

  const h2hData = h2h.total > 0 ? {
    total:       h2h.total,
    team1Wins:   h2h.t1Wins,
    team2Wins:   h2h.t2Wins,
    noResult:    h2h.noResult,
    team1WinPct: decided > 0 ? Math.round((h2h.t1Wins / decided) * 100) : 50,
    team2WinPct: decided > 0 ? Math.round((h2h.t2Wins / decided) * 100) : 50,
  } : null;

  return {
    team1Pct: t1Pct, team2Pct: t2Pct, winner, confidence, confidenceLabel,
    factors,
    venueInsights: null,
    h2hData,
    recentForm:   { team1: [], team2: [] },
    strengthData: { team1: EMPTY_STRENGTH, team2: EMPTY_STRENGTH },
  };
}

// ── Public API (mirrors tipsService) ──────────────────────────

// Knockout fixtures are sometimes published before the qualifying matches that
// decide who plays in them — Sportsmonks fills both slots with a "TBC" stub
// (same placeholder team id on both sides). Predicting "TBC vs TBC" would be
// meaningless AND would persist (PRED_TTL_DB ≈ 1 year) past the point the real
// finalists are confirmed, so skip — and re-generate naturally once Sportsmonks
// updates the fixture with the actual qualified teams.
function isPlaceholderTeam(team) {
  const name = (team?.shortName || team?.name || "").toUpperCase();
  return name === "TBC" || name === "TBD";
}

async function getMatchTip(match, table, completed, leagueSlug) {
  const t1 = match.team1?.shortName;
  const t2 = match.team2?.shortName;
  if (!t1 || !t2) return null;
  if (isPlaceholderTeam(match.team1) || isPlaceholderTeam(match.team2)) return null;
  try {
    const prediction = buildGenericPrediction(match.id, t1, t2, table, completed, leagueSlug, match.team1?.name, match.team2?.name);
    return { ...prediction, topPerformers: EMPTY_TOP_PERFORMERS };
  } catch { return null; }
}

async function getLightweightTip(match, table, completed, leagueSlug) {
  const t1 = match.team1?.shortName;
  const t2 = match.team2?.shortName;
  if (!t1 || !t2) return null;
  if (isPlaceholderTeam(match.team1) || isPlaceholderTeam(match.team2)) return null;
  try {
    const p = buildGenericPrediction(match.id, t1, t2, table, completed, leagueSlug, match.team1?.name, match.team2?.name);
    return {
      team1Pct:        p.team1Pct,
      team2Pct:        p.team2Pct,
      winner:          p.winner,
      confidence:      p.confidence,
      confidenceLabel: p.confidenceLabel,
    };
  } catch { return null; }
}

module.exports = { getMatchTip, getLightweightTip, buildGenericPrediction };
