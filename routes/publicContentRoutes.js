const express  = require("express");
const supabase = require("../config/supabase");

const router = express.Router();

// ── GET /api/notifications ────────────────────────────────────
// Returns notifications where scheduled_at <= now, newest first.

router.get("/notifications", async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  ?? "20", 10), 50);
  const offset = parseInt(req.query.offset ?? "0", 10);

  const { data, error, count } = await supabase
    .from("notifications")
    .select("*", { count: "exact" })
    .lte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({
    notifications: data ?? [],
    total:   count ?? 0,
    hasMore: (offset + limit) < (count ?? 0),
  });
});

// ── GET /api/expert-predictions ───────────────────────────────
// Returns published expert predictions, newest first.
// Pass ?league=<slug> to scope to one league (e.g. 'ipl', 'wc2026').
// Predictions with no league_id (legacy/standalone) are treated as
// league-agnostic and always included.

router.get("/expert-predictions", async (req, res) => {
  const { league } = req.query;

  // Validate league slug — alphanumeric, hyphens, underscores only
  if (league && !/^[a-z0-9_-]{1,40}$/.test(league)) {
    return res.status(400).json({ error: "Invalid league parameter" });
  }

  let query = supabase
    .from("expert_predictions")
    .select("*")
    .eq("is_published", true)
    .order("created_at", { ascending: false });

  if (league) {
    query = query.or(`league_id.eq.${league},league_id.is.null`);
  }

  const { data, error } = await query;

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ predictions: data ?? [] });
});

// ── GET /api/banners ───────────────────────────────────────────
// Returns active banners for a placement, ordered for display.
// ?placement=discovery  → banners targeting the Discovery home
// ?placement=<league>   → banners targeting that league home, plus 'all_leagues'

router.get("/banners", async (req, res) => {
  const { placement } = req.query;
  if (!placement) return res.status(400).json({ error: "placement is required" });

  // Validate placement — alphanumeric, hyphens, underscores only
  if (!/^[a-z0-9_-]{1,40}$/.test(placement)) {
    return res.status(400).json({ error: "Invalid placement parameter" });
  }

  let query = supabase.from("banners").select("*").eq("is_active", true);
  query = placement === "discovery"
    ? query.contains("placements", ["discovery"])
    : query.or(`placements.cs.{${placement}},placements.cs.{all_leagues}`);

  const { data, error } = await query.order("display_order", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ banners: data ?? [] });
});

// ── GET /api/app-version ──────────────────────────────────────
// Returns the minimum supported app version and latest version.
// Update MIN_VERSION here to force old users to update.

const MIN_VERSION    = "1.0.0";
const LATEST_VERSION = "1.0.0";

router.get("/app-version", (_req, res) => {
  res.json({
    minVersion:    MIN_VERSION,
    latestVersion: LATEST_VERSION,
    message:       "A new version of PredictX is available with improvements and bug fixes.",
  });
});

// ── GET /api/config ───────────────────────────────────────────
// Remote feature flags. Change values here to toggle features
// across all clients without a new app build.

router.get("/config", (_req, res) => {
  res.json({
    predictions_enabled:  true,
    news_enabled:         true,
    tips_enabled:         true,
    comments_enabled:     true,
    leaderboard_enabled:  true,
    maintenance_mode:     false,
    maintenance_message:  "PredictX is under maintenance. Back shortly!",
  });
});

module.exports = router;
