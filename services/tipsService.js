/**
 * tipsService.js — 7-factor prediction engine powered by IPL 2008–2025 data.
 *
 * Weights:
 *   1. Team Rating     (25%) — current season win% (≥3 games), else recent form
 *   2. Recent Form     (20%) — last 3 seasons win% (excl. current year)
 *   3. Batting Strength (15%) — avg_score + avg_sr from ipl_team_batting (last 2 seasons)
 *   4. Bowling Strength (15%) — economy + wpm from ipl_team_bowling (last 2 seasons)
 *   5. H2H             (10%) — head-to-head record
 *   6. Venue Record    (10%) — team win% at this ground
 *   7. Toss Impact      (5%) — venue toss-winner win% applied as small edge
 */

const supabase = require("../config/supabase");

// Playoff fixtures (Qualifier 1/2, Eliminator, Final) are sometimes published
// before the league-stage results that decide who plays in them — both slots
// get filled with a "TBC"/"TBD" placeholder team. Predicting that matchup would
// be meaningless and would persist (predictions are cached ~1 year), so skip —
// it regenerates naturally once Sportsmonks updates the fixture with real teams.
function isPlaceholderTeam(team) {
  const name = (team?.shortName || team?.name || "").toUpperCase();
  return name === "TBC" || name === "TBD";
}

// ── Supabase helpers ──────────────────────────────────────────

async function _query(table, filters = {}) {
  try {
    let q = supabase.from(table).select("*");
    for (const [col, val] of Object.entries(filters)) q = q.eq(col, val);
    const { data, error } = await q;
    if (error) { console.warn(`[Tips] ${table}:`, error.message); return []; }
    return data || [];
  } catch (e) { console.warn(`[Tips] ${table}:`, e.message); return []; }
}

async function getH2H(t1, t2) {
  const [a, b] = [t1, t2].sort();
  const rows = await _query("ipl_h2h", { team1: a, team2: b });
  return rows[0] || null;
}

async function getVenueOverall(venue) {
  const rows = await _query("ipl_venue_overall", { venue });
  if (rows.length) return rows[0];
  const keyword = venue.split(",")[0].trim();
  try {
    const { data } = await supabase
      .from("ipl_venue_overall")
      .select("*")
      .ilike("venue", `%${keyword}%`)
      .order("matches", { ascending: false })
      .limit(1);
    return data?.[0] || null;
  } catch { return null; }
}

async function getVenueTeam(venue, team) {
  const rows = await _query("ipl_venue_stats", { venue, team });
  if (rows.length) return rows[0];
  const keyword = venue.split(",")[0].trim();
  try {
    const { data } = await supabase
      .from("ipl_venue_stats")
      .select("*")
      .ilike("venue", `%${keyword}%`)
      .eq("team", team)
      .order("matches", { ascending: false })
      .limit(1);
    return data?.[0] || null;
  } catch { return null; }
}

async function getTeamSeasons(team) {
  try {
    const { data, error } = await supabase
      .from("ipl_team_season")
      .select("*")
      .eq("team", team)
      .order("season", { ascending: false });
    if (error) return [];
    return data || [];
  } catch { return []; }
}

async function getTeamBatting(team) {
  try {
    const { data } = await supabase
      .from("ipl_team_batting")
      .select("*")
      .eq("team", team)
      .order("season", { ascending: false })
      .limit(2);
    return data || [];
  } catch { return []; }
}

async function getTeamBowling(team) {
  try {
    const { data } = await supabase
      .from("ipl_team_bowling")
      .select("*")
      .eq("team", team)
      .order("season", { ascending: false })
      .limit(2);
    return data || [];
  } catch { return []; }
}

async function getTopBattersVsTeam(vsTeam, limit = 5) {
  try {
    const { data } = await supabase
      .from("ipl_player_vs_team")
      .select("*")
      .eq("vs_team", vsTeam)
      .gte("batter_balls", 30)
      .order("batter_runs", { ascending: false })
      .limit(limit);
    return (data || []).map(r => ({
      player:     r.player,
      runs:       r.batter_runs,
      balls:      r.batter_balls,
      dismissals: r.batter_dismissals,
      average:    r.batter_dismissals > 0
        ? +(r.batter_runs / r.batter_dismissals).toFixed(1) : r.batter_runs,
      strikeRate: +((r.batter_runs / r.batter_balls) * 100).toFixed(1),
    }));
  } catch { return []; }
}

async function getTopBowlersVsTeam(vsTeam, limit = 5) {
  try {
    const { data } = await supabase
      .from("ipl_player_vs_team")
      .select("*")
      .eq("vs_team", vsTeam)
      .gte("bowler_balls", 24)
      .order("bowler_wickets", { ascending: false })
      .limit(limit);
    return (data || []).map(r => ({
      player:  r.player,
      wickets: r.bowler_wickets,
      runs:    r.bowler_runs,
      balls:   r.bowler_balls,
      economy: r.bowler_balls > 0
        ? +(r.bowler_runs / (r.bowler_balls / 6)).toFixed(1) : 0,
    }));
  } catch { return []; }
}

// ── Normalisation helpers ─────────────────────────────────────

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// Average rows' numeric field (returns null if no data)
function avgField(rows, field) {
  if (!rows.length) return null;
  const sum = rows.reduce((s, r) => s + (parseFloat(r[field]) || 0), 0);
  return sum / rows.length;
}

/**
 * Score 0–1 for batting strength.
 * avg_score range: 130–200 (IPL typical)
 * avg_sr range:    115–160
 */
function battingStrengthScore(rows) {
  if (!rows.length) return 0.5;
  const avgScore = avgField(rows, "avg_score");
  const avgSR    = avgField(rows, "avg_sr");
  if (avgScore === null || avgSR === null) return 0.5;
  const normScore = clamp01((avgScore - 130) / 70);  // 130→0, 200→1
  const normSR    = clamp01((avgSR - 115) / 45);     // 115→0, 160→1
  return 0.6 * normScore + 0.4 * normSR;
}

/**
 * Score 0–1 for bowling strength.
 * economy:          7.0–10.5 (lower is better)
 * wickets_per_match: 3–8     (higher is better)
 */
function bowlingStrengthScore(rows) {
  if (!rows.length) return 0.5;
  const eco = avgField(rows, "economy");
  const wpm = avgField(rows, "wickets_per_match");
  if (eco === null || wpm === null) return 0.5;
  const normEco = clamp01((10.5 - eco) / 3.5);  // 10.5→0, 7.0→1
  const normWpm = clamp01((wpm - 3) / 5);        // 3→0, 8→1
  return 0.5 * normEco + 0.5 * normWpm;
}

function recentFormScore(seasons, n = 3) {
  const recent  = seasons.slice(0, n);
  if (!recent.length) return 0.5;
  const wins    = recent.reduce((s, r) => s + (r.wins || 0), 0);
  const matches = recent.reduce((s, r) => s + (r.matches || 0), 0);
  return matches > 0 ? wins / matches : 0.5;
}

// ── Core prediction ───────────────────────────────────────────

async function buildPrediction(t1, t2, venue) {
  const currentYear = new Date().getFullYear();

  const [
    h2h, venueOverall, t1VenueRow, t2VenueRow,
    t1Seasons, t2Seasons,
    t1BatRows, t2BatRows,
    t1BowlRows, t2BowlRows,
  ] = await Promise.all([
    getH2H(t1, t2),
    getVenueOverall(venue),
    getVenueTeam(venue, t1),
    getVenueTeam(venue, t2),
    getTeamSeasons(t1),
    getTeamSeasons(t2),
    getTeamBatting(t1),
    getTeamBatting(t2),
    getTeamBowling(t1),
    getTeamBowling(t2),
  ]);

  // ── 1. Team Rating (current season win%) ─────────────────────
  const t1CurRow = t1Seasons.find(r => r.season === currentYear);
  const t2CurRow = t2Seasons.find(r => r.season === currentYear);
  const t1HasCurSeason = (t1CurRow?.matches ?? 0) >= 3;
  const t2HasCurSeason = (t2CurRow?.matches ?? 0) >= 3;

  const pastSeasons1  = t1Seasons.filter(r => r.season < currentYear);
  const pastSeasons2  = t2Seasons.filter(r => r.season < currentYear);

  const t1Rating = t1HasCurSeason
    ? (t1CurRow.wins / t1CurRow.matches)
    : recentFormScore(pastSeasons1, 3);
  const t2Rating = t2HasCurSeason
    ? (t2CurRow.wins / t2CurRow.matches)
    : recentFormScore(pastSeasons2, 3);

  // ── 2. Recent Form (last 3 seasons excl. current) ───────────
  const t1RecentPct = recentFormScore(pastSeasons1, 3);
  const t2RecentPct = recentFormScore(pastSeasons2, 3);

  // ── 3. Batting Strength ──────────────────────────────────────
  const t1BatScore  = battingStrengthScore(t1BatRows);
  const t2BatScore  = battingStrengthScore(t2BatRows);

  // ── 4. Bowling Strength ──────────────────────────────────────
  const t1BowlScore = bowlingStrengthScore(t1BowlRows);
  const t2BowlScore = bowlingStrengthScore(t2BowlRows);

  // ── 5. H2H ───────────────────────────────────────────────────
  let h2hT1Wins = 0, h2hT2Wins = 0, h2hNoResult = 0, h2hTotal = 0;
  let h2hT1Pct = 0.5;

  if (h2h && h2h.matches > 0) {
    const [sorted1] = [t1, t2].sort();
    const isT1First = sorted1 === t1;
    h2hTotal    = h2h.matches;
    h2hNoResult = h2h.no_result || 0;
    h2hT1Wins   = isT1First ? h2h.team1_wins : h2h.team2_wins;
    h2hT2Wins   = isT1First ? h2h.team2_wins : h2h.team1_wins;
    const decided = h2hT1Wins + h2hT2Wins;
    h2hT1Pct    = decided > 0 ? h2hT1Wins / decided : 0.5;
  }
  const h2hT2Pct = 1 - h2hT1Pct;

  // ── 6. Venue Record ──────────────────────────────────────────
  const t1VM   = t1VenueRow?.matches || 0;
  const t2VM   = t2VenueRow?.matches || 0;
  const t1VPct = t1VM > 0 ? (t1VenueRow.wins / t1VM) : 0.5;
  const t2VPct = t2VM > 0 ? (t2VenueRow.wins / t2VM) : 0.5;

  // ── 7. Toss Impact (venue-level) ─────────────────────────────
  // tossWinnerWinPct above 50% → small boost to whichever team wins toss (unknown pre-match)
  // We apply it as a neutral 0.5 weighting here but expose it in venueInsights.
  const tossFactor = 0.5; // symmetric pre-match

  // ── Weighted probability ──────────────────────────────────────
  const W = { rating: 0.25, recent: 0.20, bat: 0.15, bowl: 0.15, h2h: 0.10, venue: 0.10, toss: 0.05 };

  // Normalise pair-wise scores so each factor contributes proportionally
  function pairNorm(a, b) {
    const tot = a + b;
    return tot > 0 ? [a / tot, b / tot] : [0.5, 0.5];
  }

  const [ratingT1, ratingT2] = pairNorm(t1Rating, t2Rating);
  const [recentT1, recentT2] = pairNorm(t1RecentPct, t2RecentPct);
  const [batT1, batT2]       = pairNorm(t1BatScore, t2BatScore);
  const [bowlT1, bowlT2]     = pairNorm(t1BowlScore, t2BowlScore);
  const [venueT1, venueT2]   = pairNorm(t1VPct, t2VPct);

  const t1Score =
    W.rating * ratingT1 + W.recent * recentT1 +
    W.bat    * batT1    + W.bowl   * bowlT1   +
    W.h2h    * h2hT1Pct + W.venue  * venueT1  +
    W.toss   * tossFactor;

  const t2Score =
    W.rating * ratingT2 + W.recent * recentT2 +
    W.bat    * batT2    + W.bowl   * bowlT2   +
    W.h2h    * h2hT2Pct + W.venue  * venueT2  +
    W.toss   * tossFactor;

  const total = t1Score + t2Score;
  let t1Pct   = Math.round((t1Score / total) * 100);
  t1Pct       = Math.max(22, Math.min(78, t1Pct));
  const t2Pct = 100 - t1Pct;

  const winner          = t1Pct >= t2Pct ? t1 : t2;
  const confidence      = Math.max(t1Pct, t2Pct);
  const confidenceLabel =
    confidence >= 65 ? "HIGH" : confidence >= 55 ? "MEDIUM" : "LOW";

  // ── Factors (for detail page) ─────────────────────────────────

  const factors = [];

  // Team Rating
  {
    const t1Label = t1HasCurSeason
      ? `${t1CurRow.wins}W ${t1CurRow.losses}L (2026)`
      : `${Math.round(t1RecentPct * 100)}% (recent)`;
    const t2Label = t2HasCurSeason
      ? `${t2CurRow.wins}W ${t2CurRow.losses}L (2026)`
      : `${Math.round(t2RecentPct * 100)}% (recent)`;
    factors.push({
      label:      "Team Rating",
      team1Value: t1Label,
      team2Value: t2Label,
      advantage:  ratingT1 > ratingT2 + 0.05 ? "team1" : ratingT2 > ratingT1 + 0.05 ? "team2" : "neutral",
    });
  }

  // H2H
  if (h2hTotal > 0) {
    factors.push({
      label:      "Head to Head",
      team1Value: `${h2hT1Wins}/${h2hTotal} wins`,
      team2Value: `${h2hT2Wins}/${h2hTotal} wins`,
      advantage:
        h2hT1Wins > h2hT2Wins ? "team1" :
        h2hT2Wins > h2hT1Wins ? "team2" : "neutral",
    });
  }

  // Venue Record
  if (t1VM > 0 || t2VM > 0) {
    factors.push({
      label:      "Venue Record",
      team1Value: t1VM > 0 ? `${t1VenueRow.wins}W/${t1VM} (${Math.round(t1VPct * 100)}%)` : "No data",
      team2Value: t2VM > 0 ? `${t2VenueRow.wins}W/${t2VM} (${Math.round(t2VPct * 100)}%)` : "No data",
      advantage:
        t1VPct > t2VPct + 0.05 ? "team1" :
        t2VPct > t1VPct + 0.05 ? "team2" : "neutral",
    });
  }

  // Recent Form
  {
    const t1R3 = pastSeasons1.slice(0, 3);
    const t2R3 = pastSeasons2.slice(0, 3);
    const t1RW = t1R3.reduce((s, r) => s + r.wins, 0);
    const t1RM = t1R3.reduce((s, r) => s + r.matches, 0);
    const t2RW = t2R3.reduce((s, r) => s + r.wins, 0);
    const t2RM = t2R3.reduce((s, r) => s + r.matches, 0);
    if (t1RM > 0 || t2RM > 0) {
      factors.push({
        label:      "Last 3 Seasons",
        team1Value: t1RM > 0 ? `${t1RW}W ${t1RM - t1RW}L` : "No data",
        team2Value: t2RM > 0 ? `${t2RW}W ${t2RM - t2RW}L` : "No data",
        advantage:
          t1RecentPct > t2RecentPct + 0.05 ? "team1" :
          t2RecentPct > t1RecentPct + 0.05 ? "team2" : "neutral",
      });
    }
  }

  // Batting Strength
  if (t1BatRows.length > 0 || t2BatRows.length > 0) {
    const t1AvgScore = avgField(t1BatRows, "avg_score");
    const t2AvgScore = avgField(t2BatRows, "avg_score");
    factors.push({
      label:      "Batting Strength",
      team1Value: t1AvgScore !== null ? `Avg ${Math.round(t1AvgScore)} per inns` : "No data",
      team2Value: t2AvgScore !== null ? `Avg ${Math.round(t2AvgScore)} per inns` : "No data",
      advantage:  batT1 > batT2 + 0.05 ? "team1" : batT2 > batT1 + 0.05 ? "team2" : "neutral",
    });
  }

  // Bowling Strength
  if (t1BowlRows.length > 0 || t2BowlRows.length > 0) {
    const t1Eco = avgField(t1BowlRows, "economy");
    const t2Eco = avgField(t2BowlRows, "economy");
    factors.push({
      label:      "Bowling Strength",
      team1Value: t1Eco !== null ? `Econ ${t1Eco.toFixed(1)}` : "No data",
      team2Value: t2Eco !== null ? `Econ ${t2Eco.toFixed(1)}` : "No data",
      advantage:  bowlT1 > bowlT2 + 0.05 ? "team1" : bowlT2 > bowlT1 + 0.05 ? "team2" : "neutral",
    });
  }

  // ── Venue Insights ────────────────────────────────────────────
  let venueInsights = null;
  if (venueOverall) {
    const dec   = venueOverall.bat_first_wins + venueOverall.chase_wins;
    const bfPct = dec > 0 ? Math.round((venueOverall.bat_first_wins / dec) * 100) : 50;
    const twPct = venueOverall.matches > 0
      ? Math.round((venueOverall.toss_winner_match_wins / venueOverall.matches) * 100) : 50;
    venueInsights = {
      venueName:            venueOverall.venue,
      totalMatches:         venueOverall.matches,
      avgFirstInningsScore: Math.round(venueOverall.avg_first_innings_score),
      batFirstWinPct:       bfPct,
      chaseWinPct:          100 - bfPct,
      tossWinnerWinPct:     twPct,
    };
  }

  // ── H2H object ────────────────────────────────────────────────
  const h2hData = h2hTotal > 0 ? {
    total:       h2hTotal,
    team1Wins:   h2hT1Wins,
    team2Wins:   h2hT2Wins,
    noResult:    h2hNoResult,
    team1WinPct: Math.round(h2hT1Pct * 100),
    team2WinPct: Math.round(h2hT2Pct * 100),
  } : null;

  // ── Recent form per season (last 5) ──────────────────────────
  const recentForm = {
    team1: pastSeasons1.slice(0, 5).map(r => ({
      season: r.season, wins: r.wins, losses: r.losses, matches: r.matches,
      winPct: r.matches > 0 ? Math.round((r.wins / r.matches) * 100) : 0,
    })),
    team2: pastSeasons2.slice(0, 5).map(r => ({
      season: r.season, wins: r.wins, losses: r.losses, matches: r.matches,
      winPct: r.matches > 0 ? Math.round((r.wins / r.matches) * 100) : 0,
    })),
  };

  // ── Batting/bowling stats for display ─────────────────────────
  const strengthData = {
    team1: {
      batAvgScore:  t1BatRows.length ? Math.round(avgField(t1BatRows, "avg_score") ?? 0) : null,
      batAvgSR:     t1BatRows.length ? Math.round(avgField(t1BatRows, "avg_sr") ?? 0) : null,
      bowlEconomy:  t1BowlRows.length ? +(avgField(t1BowlRows, "economy") ?? 0).toFixed(1) : null,
      bowlWpm:      t1BowlRows.length ? +(avgField(t1BowlRows, "wickets_per_match") ?? 0).toFixed(1) : null,
    },
    team2: {
      batAvgScore:  t2BatRows.length ? Math.round(avgField(t2BatRows, "avg_score") ?? 0) : null,
      batAvgSR:     t2BatRows.length ? Math.round(avgField(t2BatRows, "avg_sr") ?? 0) : null,
      bowlEconomy:  t2BowlRows.length ? +(avgField(t2BowlRows, "economy") ?? 0).toFixed(1) : null,
      bowlWpm:      t2BowlRows.length ? +(avgField(t2BowlRows, "wickets_per_match") ?? 0).toFixed(1) : null,
    },
  };

  return {
    team1Pct: t1Pct, team2Pct: t2Pct, winner, confidence, confidenceLabel,
    factors, venueInsights, h2hData, recentForm, strengthData,
  };
}

// ── Top performers (squad-independent, from historical data) ──

async function buildTopPerformers(t1, t2) {
  const [battersVsT2, battersVsT1, bowlersVsT2, bowlersVsT1] = await Promise.all([
    getTopBattersVsTeam(t2, 5),
    getTopBattersVsTeam(t1, 5),
    getTopBowlersVsTeam(t2, 5),
    getTopBowlersVsTeam(t1, 5),
  ]);
  return { battersVsT2, battersVsT1, bowlersVsT2, bowlersVsT1 };
}

// ── Public API ────────────────────────────────────────────────

async function getMatchTip(match, _squad = null) {
  const t1    = match.team1?.shortName;
  const t2    = match.team2?.shortName;
  const venue = match.venue || "";
  if (!t1 || !t2) return null;
  if (isPlaceholderTeam(match.team1) || isPlaceholderTeam(match.team2)) return null;

  const [prediction, topPerformers] = await Promise.all([
    buildPrediction(t1, t2, venue),
    buildTopPerformers(t1, t2),
  ]);

  return { ...prediction, topPerformers };
}

/**
 * Lightweight prediction for list cards — only win%, confidence.
 * Skips topPerformers for speed.
 */
async function getLightweightTip(match) {
  const t1    = match.team1?.shortName;
  const t2    = match.team2?.shortName;
  const venue = match.venue || "";
  if (!t1 || !t2) return null;
  if (isPlaceholderTeam(match.team1) || isPlaceholderTeam(match.team2)) return null;
  try {
    const p = await buildPrediction(t1, t2, venue);
    return {
      team1Pct:        p.team1Pct,
      team2Pct:        p.team2Pct,
      winner:          p.winner,
      confidence:      p.confidence,
      confidenceLabel: p.confidenceLabel,
    };
  } catch { return null; }
}

module.exports = { getMatchTip, getLightweightTip };
