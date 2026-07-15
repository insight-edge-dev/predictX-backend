/**
 * upvoteService.js
 *
 * Toggle upvotes on PredictX AI predictions (per match).
 * One upvote per user per match — idempotent toggle.
 */

const supabase = require("../config/supabase");

/**
 * Toggle upvote for a user on a match prediction.
 * Returns { upvoted: boolean, count: number }.
 */
async function toggleUpvote(userId, matchId) {
  // Check if already upvoted
  const { data: existing } = await supabase
    .from("prediction_upvotes")
    .select("user_id")
    .eq("user_id", userId)
    .eq("match_id", matchId)
    .single();

  if (existing) {
    await supabase
      .from("prediction_upvotes")
      .delete()
      .eq("user_id", userId)
      .eq("match_id", matchId);
  } else {
    await supabase
      .from("prediction_upvotes")
      .insert({ user_id: userId, match_id: matchId });
  }

  const { count } = await supabase
    .from("prediction_upvotes")
    .select("*", { count: "exact", head: true })
    .eq("match_id", matchId);

  return { upvoted: !existing, count: count ?? 0 };
}

/**
 * Get upvote count + whether the requesting user has upvoted.
 */
async function getUpvoteStatus(userId, matchId) {
  const [countResult, userResult] = await Promise.all([
    supabase
      .from("prediction_upvotes")
      .select("*", { count: "exact", head: true })
      .eq("match_id", matchId),
    userId
      ? supabase
          .from("prediction_upvotes")
          .select("user_id")
          .eq("user_id", userId)
          .eq("match_id", matchId)
          .single()
      : Promise.resolve({ data: null }),
  ]);

  return {
    count:   countResult.count ?? 0,
    upvoted: !!userResult.data,
  };
}

module.exports = { toggleUpvote, getUpvoteStatus };
