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

// Atomic poll update via Postgres RPC — avoids read-modify-write race condition.
// SQL to create the function (run once in Supabase SQL Editor):
//
//   create or replace function update_prediction_poll(
//     p_match_id text, p_team_a_name text, p_team_b_name text,
//     p_old_winner text, p_new_winner text
//   ) returns void language plpgsql as $$
//   declare
//     v_a int:=0; v_b int:=0; v_draw int:=0; v_tot int:=0;
//   begin
//     if p_old_winner = p_team_a_name then v_a:=v_a-1; v_tot:=v_tot-1;
//     elsif p_old_winner = 'draw'     then v_draw:=v_draw-1; v_tot:=v_tot-1;
//     elsif p_old_winner is not null  then v_b:=v_b-1; v_tot:=v_tot-1; end if;
//     if p_new_winner = p_team_a_name then v_a:=v_a+1; v_tot:=v_tot+1;
//     elsif p_new_winner = 'draw'     then v_draw:=v_draw+1; v_tot:=v_tot+1;
//     else                                 v_b:=v_b+1; v_tot:=v_tot+1; end if;
//     insert into match_prediction_stats
//       (match_id,team_a_name,team_b_name,team_a_count,draw_count,team_b_count,total,updated_at)
//     values(p_match_id,p_team_a_name,p_team_b_name,greatest(0,v_a),greatest(0,v_draw),greatest(0,v_b),greatest(0,v_tot),now())
//     on conflict(match_id) do update set
//       team_a_count=greatest(0,match_prediction_stats.team_a_count+v_a),
//       draw_count  =greatest(0,match_prediction_stats.draw_count+v_draw),
//       team_b_count=greatest(0,match_prediction_stats.team_b_count+v_b),
//       total       =greatest(0,match_prediction_stats.total+v_tot),
//       updated_at  =now();
//   end; $$;

async function _updatePollCache(matchId, teamAName, teamBName, oldWinner, newWinner) {
  const { error } = await supabase.rpc("update_prediction_poll", {
    p_match_id:    matchId,
    p_team_a_name: teamAName,
    p_team_b_name: teamBName,
    p_old_winner:  oldWinner ?? null,
    p_new_winner:  newWinner,
  });
  if (error) console.error("[Prediction] poll update RPC error:", error.message);
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
