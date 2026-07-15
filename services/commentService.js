/**
 * commentService.js
 *
 * Flat real-time comments on match detail pages and tip detail pages.
 * Realtime delivery is handled client-side via Supabase channel subscription
 * on the match_comments table (enabled in Supabase Dashboard → Replication).
 *
 * context_type: 'match' | 'tip'
 * context_id  : matchId string
 */

const supabase = require("../config/supabase");

const PAGE_SIZE = 30;

/**
 * Post a new comment.
 * display_name is stored at write time so it survives future profile changes.
 */
async function postComment(userId, displayName, contextType, contextId, content) {
  const trimmed = content?.trim();
  if (!trimmed || trimmed.length > 280) {
    throw Object.assign(new Error("Comment must be 1–280 characters"), { status: 400 });
  }

  const { data, error } = await supabase
    .from("match_comments")
    .insert({
      user_id:      userId,
      display_name: displayName,
      context_type: contextType,
      context_id:   contextId,
      content:      trimmed,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Fetch paginated comments, newest-first.
 * cursor = created_at of last item received (for cursor-based pagination).
 */
async function getComments(contextType, contextId, cursor = null) {
  let query = supabase
    .from("match_comments")
    .select("id, user_id, display_name, content, created_at")
    .eq("context_type", contextType)
    .eq("context_id", contextId)
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);

  if (cursor) {
    query = query.lt("created_at", cursor);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

/**
 * Admin: list all comments with optional filter, newest-first.
 */
async function listCommentsAdmin({ contextType, page = 1 } = {}) {
  let query = supabase
    .from("match_comments")
    .select("id, user_id, display_name, context_type, context_id, content, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((page - 1) * 50, page * 50 - 1);

  if (contextType) query = query.eq("context_type", contextType);

  const { data, error, count } = await query;
  if (error) throw error;
  return { comments: data ?? [], total: count ?? 0 };
}

/**
 * Admin: delete a comment by ID.
 */
async function deleteComment(commentId) {
  const { error } = await supabase
    .from("match_comments")
    .delete()
    .eq("id", commentId);

  if (error) throw error;
}

module.exports = { postComment, getComments, listCommentsAdmin, deleteComment };
