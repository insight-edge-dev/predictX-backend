/**
 * communityRoutes.js
 *
 * Comments:
 *   GET  /api/comments/:contextType/:contextId   fetch paginated comments
 *   POST /api/comments                           post a comment (auth)
 *
 * User match predictions:
 *   GET  /api/user-predictions/:matchId          get own prediction (auth)
 *   POST /api/user-predictions/:matchId          submit prediction (auth)
 *   PUT  /api/user-predictions/:matchId          change prediction once (auth)
 *   GET  /api/predictions/poll/:matchId          poll % (public)
 *   GET  /api/leaderboard                        top predictors (public)
 *   GET  /api/user-predictions/stats/me          own stats (auth)
 *
 * AI prediction upvotes:
 *   GET  /api/upvotes/:matchId                   count + did I upvote (auth optional)
 *   POST /api/upvotes/:matchId                   toggle upvote (auth)
 */

const express       = require("express");
const { requireAuth, optionalAuth } = require("../middleware/authMiddleware");
const commentSvc    = require("../services/commentService");
const predSvc       = require("../services/userPredictionService");
const upvoteSvc     = require("../services/upvoteService");
const { getCache, setCache } = require("../services/cacheService");
const supabase      = require("../config/supabase");

async function getDisplayName(userId) {
  try {
    const { data } = await supabase.from("app_users").select("display_name").eq("id", userId).single();
    return data?.display_name || "User";
  } catch {
    return "User";
  }
}

const router = express.Router();

// ── Comments ──────────────────────────────────────────────────

router.get("/comments/:contextType/:contextId", async (req, res) => {
  const { contextType, contextId } = req.params;
  if (!["match", "tip"].includes(contextType)) {
    return res.status(400).json({ error: "contextType must be match or tip" });
  }
  try {
    const { cursor } = req.query;
    const comments = await commentSvc.getComments(contextType, contextId, cursor || null);
    return res.json({ comments });
  } catch (e) {
    console.error("[Comments GET]", e.message);
    return res.status(500).json({ error: "Failed to fetch comments" });
  }
});

router.post("/comments", requireAuth, async (req, res) => {
  const { contextType, contextId, content } = req.body;
  if (!["match", "tip"].includes(contextType)) {
    return res.status(400).json({ error: "contextType must be match or tip" });
  }
  if (!contextId) return res.status(400).json({ error: "contextId is required" });

  try {
    const displayName = await getDisplayName(req.user.id);
    const comment = await commentSvc.postComment(
      req.user.id,
      displayName,
      contextType,
      String(contextId),
      content,
    );
    return res.status(201).json({ comment });
  } catch (e) {
    console.error("[Comments POST]", e.message);
    return res.status(e.status ?? 500).json({ error: e.message });
  }
});

// ── User Predictions ──────────────────────────────────────────

// Public poll — no auth needed
router.get("/predictions/poll/:matchId", async (req, res) => {
  try {
    const poll = await predSvc.getPoll(req.params.matchId);
    return res.json(poll);
  } catch (e) {
    console.error("[Poll GET]", e.message);
    return res.status(500).json({ error: "Failed to fetch poll" });
  }
});

// Leaderboard — public
router.get("/leaderboard", async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 20, 50);
    const period = req.query.period === "week" ? "week" : "all";
    const cacheKey = `leaderboard:${period}:${limit}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json({ leaderboard: cached });
    const board  = await predSvc.getLeaderboard(limit, period);
    setCache(cacheKey, board, 5 * 60); // 5-minute TTL
    return res.json({ leaderboard: board });
  } catch (e) {
    console.error("[Leaderboard GET]", e.message);
    return res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});

// Own stats — auth required
router.get("/user-predictions/stats/me", requireAuth, async (req, res) => {
  try {
    const stats = await predSvc.getUserStats(req.user.id);
    return res.json(stats);
  } catch (e) {
    console.error("[UserStats GET]", e.message);
    return res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// Own prediction history — auth required
router.get("/user-predictions/history/me", requireAuth, async (req, res) => {
  try {
    const history = await predSvc.getUserPredictionHistory(req.user.id);
    return res.json({ predictions: history });
  } catch (e) {
    console.error("[UserPredictionHistory GET]", e.message);
    return res.status(500).json({ error: "Failed to fetch prediction history" });
  }
});

// Own prediction for a match — auth required
router.get("/user-predictions/:matchId", requireAuth, async (req, res) => {
  try {
    const pred = await predSvc.getUserPrediction(req.user.id, req.params.matchId);
    return res.json({ prediction: pred });
  } catch (e) {
    console.error("[UserPrediction GET]", e.message);
    return res.status(500).json({ error: "Failed to fetch prediction" });
  }
});

// Submit prediction — auth required
router.post("/user-predictions/:matchId", requireAuth, async (req, res) => {
  const { predictedWinner, teamA, teamB, sport } = req.body;
  if (!predictedWinner || !teamA || !teamB || !sport) {
    return res.status(400).json({ error: "predictedWinner, teamA, teamB and sport are required" });
  }
  try {
    const displayName = await getDisplayName(req.user.id);
    await predSvc.submitPrediction(
      req.user.id,
      displayName,
      req.params.matchId,
      sport,
      predictedWinner,
      teamA,
      teamB,
    );
    return res.status(201).json({ success: true });
  } catch (e) {
    console.error("[UserPrediction POST]", e.message);
    return res.status(e.status ?? 500).json({ error: e.message });
  }
});

// Change prediction (once only) — auth required
router.put("/user-predictions/:matchId", requireAuth, async (req, res) => {
  const { predictedWinner } = req.body;
  if (!predictedWinner) return res.status(400).json({ error: "predictedWinner is required" });
  try {
    await predSvc.changePrediction(req.user.id, req.params.matchId, predictedWinner);
    return res.json({ success: true });
  } catch (e) {
    console.error("[UserPrediction PUT]", e.message);
    return res.status(e.status ?? 500).json({ error: e.message });
  }
});

// ── Upvotes ───────────────────────────────────────────────────

router.get("/upvotes/:matchId", optionalAuth, async (req, res) => {
  try {
    const status = await upvoteSvc.getUpvoteStatus(req.user?.id ?? null, req.params.matchId);
    return res.json(status);
  } catch (e) {
    console.error("[Upvote GET]", e.message);
    return res.status(500).json({ error: "Failed to fetch upvote status" });
  }
});

router.post("/upvotes/:matchId", requireAuth, async (req, res) => {
  try {
    const result = await upvoteSvc.toggleUpvote(req.user.id, req.params.matchId);
    return res.json(result);
  } catch (e) {
    console.error("[Upvote POST]", e.message);
    return res.status(500).json({ error: "Failed to toggle upvote" });
  }
});

module.exports = router;
