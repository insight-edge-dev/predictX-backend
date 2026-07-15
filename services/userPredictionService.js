/**
 * userPredictionService.js
 *
 * Handles user match predictions (pick winner).
 *
 * Rules:
 *  - One prediction per user per match.
 *  - User may change their pick exactly once (has_changed flips to true).
 *  - Predictions can be submitted/changed anytime before the match ends.
 *  - result is resolved externally when match completes:
 *      'correct' | 'wrong' | 'void' (abandoned / no result)
 *  - poll stats are kept in match_prediction_stats as running counts
 *    so frontend can show % without a GROUP BY on every request.
 */

const supabase = require("../config/supabase");

// ── Helpers ───────────────────────────────────────────────────

function err(msg, status) {
  return Object.assign(new Error(msg), { status });
}

async function _updatePollCache(matchId, teamAName, teamBName, oldWinner, newWinner) {
  // Fetch current row (may not exist yet)
  const { data: row } = await supabase
    .from("match_prediction_stats")
    .select("*")
    .eq("match_id", matchId)
    .single();

  if (!row) {
    // First prediction for this match — create the row
    const initial = {
      match_id:     matchId,
      team_a_name:  teamAName,
      team_b_name:  teamBName,
      team_a_count: newWinner === teamAName ? 1 : 0,
      draw_count:   newWinner === "draw"    ? 1 : 0,
      team_b_count: newWinner === teamBName ? 1 : 0,
      total:        1,
      updated_at:   new Date().toISOString(),
    };
    await supabase.from("match_prediction_stats").insert(initial);
    return;
  }

  // Build incremental update
  const patch = { updated_at: new Date().toISOString() };

  // Decrement old pick
  if (oldWinner) {
    if (oldWinner === row.team_a_name) patch.team_a_count = Math.max(0, row.team_a_count - 1);
    else if (oldWinner === "draw")     patch.draw_count   = Math.max(0, row.draw_count   - 1);
    else                               patch.team_b_count = Math.max(0, row.team_b_count - 1);
    patch.total = Math.max(0, row.total - 1);
  }

  // Increment new pick (work from already-patched values)
  const curA    = patch.team_a_count ?? row.team_a_count;
  const curDraw = patch.draw_count   ?? row.draw_count;
  const curB    = patch.team_b_count ?? row.team_b_count;
  const curTot  = patch.total        ?? row.total;

  if (newWinner === row.team_a_name) patch.team_a_count = curA    + 1;
  else if (newWinner === "draw")     patch.draw_count   = curDraw + 1;
  else                               patch.team_b_count = curB    + 1;
  patch.total = curTot + 1;

  await supabase.from("match_prediction_stats").update(patch).eq("match_id", matchId);
}

// ── Public API ────────────────────────────────────────────────

/**
 * Submit a new prediction for a match.
 * teamA / teamB are display names used to label the poll.
 */
async function submitPrediction(userId, displayName, matchId, sport, predictedWinner, teamA, teamB) {
  if (!["draw", teamA, teamB].includes(predictedWinner)) {
    throw err("predictedWinner must be teamA name, teamB name, or 'draw'", 400);
  }

  const { error } = await supabase
    .from("user_match_predictions")
    .insert({
      user_id:          userId,
      display_name:     displayName,
      match_id:         matchId,
      sport,
      team_a:           teamA,
      team_b:           teamB,
      predicted_winner: predictedWinner,
    });

  if (error) {
    if (error.code === "23505") throw err("You already predicted this match", 409);
    throw error;
  }

  await _updatePollCache(matchId, teamA, teamB, null, predictedWinner);
}

/**
 * Change an existing prediction (allowed once only, before match ends).
 */
async function changePrediction(userId, matchId, newWinner) {
  const { data: existing, error: fetchErr } = await supabase
    .from("user_match_predictions")
    .select("*")
    .eq("user_id", userId)
    .eq("match_id", matchId)
    .single();

  if (fetchErr || !existing) throw err("No prediction found for this match", 404);
  if (existing.has_changed)  throw err("You have already used your one change", 409);
  if (existing.result)       throw err("Match is already resolved — prediction is locked", 409);

  if (!["draw", existing.team_a, existing.team_b].includes(newWinner)) {
    throw err("Invalid winner choice", 400);
  }

  const { error } = await supabase
    .from("user_match_predictions")
    .update({
      predicted_winner: newWinner,
      has_changed:      true,
      updated_at:       new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("match_id", matchId);

  if (error) throw error;

  await _updatePollCache(matchId, existing.team_a, existing.team_b, existing.predicted_winner, newWinner);
}

/**
 * Get the requesting user's own prediction for a match.
 */
async function getUserPrediction(userId, matchId) {
  const { data } = await supabase
    .from("user_match_predictions")
    .select("id, predicted_winner, has_changed, result, team_a, team_b, created_at")
    .eq("user_id", userId)
    .eq("match_id", matchId)
    .single();

  return data ?? null;
}

/**
 * Get poll percentages for a match (public, no auth needed).
 */
async function getPoll(matchId) {
  const { data } = await supabase
    .from("match_prediction_stats")
    .select("*")
    .eq("match_id", matchId)
    .single();

  if (!data || data.total === 0) {
    return { total: 0, teamA: null, teamB: null, teamAPercent: 0, drawPercent: 0, teamBPercent: 0 };
  }

  const pct = (n) => Math.round((n / data.total) * 100);
  return {
    total:         data.total,
    teamA:         data.team_a_name,
    teamB:         data.team_b_name,
    teamAPercent:  pct(data.team_a_count),
    drawPercent:   pct(data.draw_count),
    teamBPercent:  pct(data.team_b_count),
  };
}

/**
 * Resolve all predictions for a match once it finishes.
 * actualResult: team name that won, or 'draw', or 'void' (abandoned).
 * Called by the match-completion scheduler hook.
 */
async function resolvePredictions(matchId, actualResult) {
  // void — mark all pending predictions for this match as void
  if (actualResult === "void") {
    const { error } = await supabase
      .from("user_match_predictions")
      .update({ result: "void" })
      .eq("match_id", matchId)
      .is("result", null);
    if (error) throw error;
    return;
  }

  // Two UPDATE passes: correct picks and wrong picks.
  // Using UPDATE (not upsert) so PostgreSQL never attempts an INSERT,
  // which would violate the user_id NOT NULL constraint.
  const { error: e1 } = await supabase
    .from("user_match_predictions")
    .update({ result: "correct" })
    .eq("match_id", matchId)
    .eq("predicted_winner", actualResult)
    .is("result", null);
  if (e1) throw e1;

  const { error: e2 } = await supabase
    .from("user_match_predictions")
    .update({ result: "wrong" })
    .eq("match_id", matchId)
    .neq("predicted_winner", actualResult)
    .is("result", null);
  if (e2) throw e2;
}

/**
 * Get top predictors leaderboard.
 * period: 'week' (last 7 days) | 'all' (all-time, default)
 */
async function getLeaderboard(limit = 20, period = "all") {
  let query = supabase
    .from("user_match_predictions")
    .select("user_id, display_name, result, created_at")
    .not("result", "is", null)
    .neq("result", "void")
    .limit(20000);

  if (period === "week") {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    query = query.gte("created_at", weekAgo);
  }

  const { data, error } = await query;

  if (error) throw error;

  // Aggregate per user
  const map = new Map();
  for (const row of data ?? []) {
    if (!map.has(row.user_id)) {
      map.set(row.user_id, { user_id: row.user_id, display_name: row.display_name, correct: 0, total: 0 });
    }
    const entry = map.get(row.user_id);
    entry.total++;
    if (row.result === "correct") entry.correct++;
  }

  const MIN_PREDICTIONS = 5;

  return Array.from(map.values())
    .filter(e => e.total >= MIN_PREDICTIONS)
    .map(e => {
      const accuracy = e.total ? Math.round((e.correct / e.total) * 100) : 0;
      const score    = e.total ? parseFloat((e.correct * e.correct / e.total).toFixed(1)) : 0;
      return { ...e, accuracy, score };
    })
    .sort((a, b) => b.score - a.score || b.total - a.total)
    .slice(0, limit)
    .map((e, i) => ({ rank: i + 1, ...e }));
}

/**
 * Get prediction summary for a single user (for profile screen).
 */
async function getUserStats(userId) {
  const { data, error } = await supabase
    .from("user_match_predictions")
    .select("result")
    .eq("user_id", userId);

  if (error) throw error;

  const rows    = data ?? [];
  const correct = rows.filter(r => r.result === "correct").length;
  const wrong   = rows.filter(r => r.result === "wrong").length;
  const pending = rows.filter(r => r.result === null).length;
  const resolved = correct + wrong; // void excluded from accuracy calc
  return {
    correct,
    wrong,
    pending,
    total:    rows.length,
    accuracy: resolved ? Math.round((correct / resolved) * 100) : 0,
  };
}

/**
 * Get all predictions for a user, newest first.
 */
async function getUserPredictionHistory(userId) {
  const { data, error } = await supabase
    .from("user_match_predictions")
    .select("id, match_id, sport, team_a, team_b, predicted_winner, has_changed, result, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

module.exports = {
  submitPrediction,
  changePrediction,
  getUserPrediction,
  getPoll,
  resolvePredictions,
  getLeaderboard,
  getUserStats,
  getUserPredictionHistory,
};
