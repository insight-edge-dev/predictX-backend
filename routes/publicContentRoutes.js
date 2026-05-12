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

router.get("/expert-predictions", async (_req, res) => {
  const { data, error } = await supabase
    .from("expert_predictions")
    .select("*")
    .eq("is_published", true)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ predictions: data ?? [] });
});

module.exports = router;
