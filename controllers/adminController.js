/**
 * adminController.js — handlers for admin-only endpoints.
 *
 * Notifications:
 *   POST   /api/admin/notifications          create (schedule or now)
 *   GET    /api/admin/notifications          list all
 *   DELETE /api/admin/notifications/:id      delete
 *
 * Expert Predictions:
 *   POST   /api/admin/expert-predictions     create
 *   PUT    /api/admin/expert-predictions/:id edit (triggers Supabase Realtime)
 *   DELETE /api/admin/expert-predictions/:id delete
 *   GET    /api/admin/expert-predictions     list all (including unpublished)
 *
 * Matches helper:
 *   GET    /api/admin/matches                upcoming IPL matches for picker
 *
 * Banners:
 *   POST   /api/admin/banners/upload         upload banner image to Cloudinary
 *   POST   /api/admin/banners                create
 *   GET    /api/admin/banners                list all
 *   PUT    /api/admin/banners/:id            edit
 *   PUT    /api/admin/banners/reorder        reorder
 *   DELETE /api/admin/banners/:id            delete
 */

const supabase      = require("../config/supabase");
const { LEAGUES, FOOTBALL_LEAGUES, getLeague } = require("../config/leaguesConfig");
const leagueService       = require("../services/leagueService");
const footballService     = require("../services/footballService");
const intlService         = require("../services/internationalService");
const adminDashboardService = require("../services/adminDashboardService");
const cloudinaryService    = require("../services/cloudinaryService");

const BANNER_LINK_TYPES = ["none", "external", "match", "tip", "league_home", "app_section"];

// Virtual league entries that don't live in leaguesConfig (no Sportsmonks IDs)
const VIRTUAL_LEAGUES = [
  { slug: "t20i", name: "Twenty20 International", short: "T20I", flag: "🌍" },
];

// ── Notifications ─────────────────────────────────────────────

async function createNotification(req, res) {
  const { title, body, image_url, link_url, link_title, scheduled_at } = req.body;
  if (!title?.trim() || !body?.trim()) {
    return res.status(400).json({ error: "title and body are required" });
  }

  const { data, error } = await supabase
    .from("notifications")
    .insert({
      title:        title.trim(),
      body:         body.trim(),
      image_url:    image_url?.trim()  || null,
      link_url:     link_url?.trim()   || null,
      link_title:   link_title?.trim() || null,
      scheduled_at: scheduled_at ?? new Date().toISOString(),
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ notification: data });
}

async function listNotificationsAdmin(req, res) {
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .order("scheduled_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ notifications: data ?? [] });
}

async function deleteNotification(req, res) {
  const { id } = req.params;
  const { error } = await supabase.from("notifications").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
}

// ── Expert Predictions ────────────────────────────────────────

async function createExpertPrediction(req, res) {
  const { match_id, match_label, league_id, predicted_winner, confidence, analysis, is_published } = req.body;
  if (!predicted_winner?.trim() || !analysis?.trim()) {
    return res.status(400).json({ error: "predicted_winner and analysis are required" });
  }

  const { data, error } = await supabase
    .from("expert_predictions")
    .insert({
      match_id:        match_id        ?? null,
      match_label:     match_label     ?? null,
      league_id:       league_id       ?? null,
      predicted_winner: predicted_winner.trim(),
      confidence:      confidence      ?? "MEDIUM",
      analysis:        analysis.trim(),
      is_published:    is_published    ?? true,
      updated_at:      new Date().toISOString(),
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ prediction: data });
}

async function updateExpertPrediction(req, res) {
  const { id } = req.params;
  const { match_id, match_label, league_id, predicted_winner, confidence, analysis, is_published } = req.body;

  const updates = {
    updated_at: new Date().toISOString(),
  };
  if (match_id         !== undefined) updates.match_id         = match_id;
  if (match_label      !== undefined) updates.match_label      = match_label;
  if (league_id        !== undefined) updates.league_id        = league_id;
  if (predicted_winner !== undefined) updates.predicted_winner = predicted_winner.trim();
  if (confidence       !== undefined) updates.confidence       = confidence;
  if (analysis         !== undefined) updates.analysis         = analysis.trim();
  if (is_published     !== undefined) updates.is_published     = is_published;

  const { data, error } = await supabase
    .from("expert_predictions")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  // Supabase Realtime automatically broadcasts this UPDATE to all subscribers
  return res.json({ prediction: data });
}

async function deleteExpertPrediction(req, res) {
  const { id } = req.params;
  const { error } = await supabase.from("expert_predictions").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
}

async function listExpertPredictionsAdmin(req, res) {
  const { data, error } = await supabase
    .from("expert_predictions")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ predictions: data ?? [] });
}

// ── Match picker helper ───────────────────────────────────────

async function getUpcomingMatchesPicker(req, res) {
  const { league: leagueSlug } = req.query;

  // Return full league list when no slug provided
  if (!leagueSlug) {
    const cricketLeagues  = Object.values(LEAGUES).map(l => ({ slug: l.slug, name: l.name, short: l.short, flag: l.flag }));
    const footballLeagues = Object.values(FOOTBALL_LEAGUES).map(l => ({ slug: l.slug, name: l.name, short: l.short, flag: l.flag }));
    const leagues = [...cricketLeagues, ...footballLeagues, ...VIRTUAL_LEAGUES];
    return res.json({ leagues, matches: [] });
  }

  const fmtDate = (d) => d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "";

  try {
    // ── Football leagues (wc2026, etc.) ──
    if (FOOTBALL_LEAGUES[leagueSlug]) {
      const { live, upcoming } = await footballService.getMatches();
      const list = [...live, ...upcoming].map(m => {
        const h = m.homeTeam?.shortName || m.homeTeam?.tla || m.homeTeam?.name || "TBA";
        const a = m.awayTeam?.shortName || m.awayTeam?.tla || m.awayTeam?.name || "TBA";
        return { id: String(m.id), label: `${h} vs ${a} (${fmtDate(m.date)})`, date: m.date ?? "" };
      });
      list.sort((a, b) => new Date(a.date) - new Date(b.date));
      return res.json({ matches: list });
    }

    // ── International T20I ──
    if (leagueSlug === "t20i") {
      const bucket   = intlService.INTERNATIONAL_LEAGUES.t20i;
      const fixtures = await intlService.getBucketFixtures(bucket);
      const list = fixtures
        .filter(m => {
          const st = m.status;
          const startedInPast = m.date && (Date.now() - new Date(m.date).getTime()) > 4 * 60 * 60 * 1000;
          return st !== "completed" && !startedInPast;
        })
        .map(m => {
          const t1 = m.team1?.shortName || m.team1?.name || "TBA";
          const t2 = m.team2?.shortName || m.team2?.name || "TBA";
          const series = m.stageName ? ` · ${m.stageName.replace(/ tour of .+/, " tour")}` : "";
          return { id: String(m.id), label: `${t1} vs ${t2}${series} (${fmtDate(m.date)})`, date: m.date ?? "" };
        });
      list.sort((a, b) => new Date(a.date) - new Date(b.date));
      return res.json({ matches: list });
    }

    // ── Cricket leagues (ipl, bbl, psl, etc.) ──
    const league = getLeague(leagueSlug);
    if (!league) return res.status(400).json({ error: "Unknown league slug" });

    const { upcoming, live } = await leagueService.getLeagueMatches(league);
    const list = [...live, ...upcoming].map(m => {
      const t1   = m.team1?.shortName || m.team1?.name || "TBA";
      const t2   = m.team2?.shortName || m.team2?.name || "TBA";
      return { id: String(m.id), label: `${t1} vs ${t2} (${fmtDate(m.date)})`, date: m.date ?? "" };
    });
    list.sort((a, b) => new Date(a.date) - new Date(b.date));
    return res.json({ matches: list });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── Dashboard ──────────────────────────────────────────────────

async function getOverview(req, res) {
  try {
    const stats = await adminDashboardService.getOverviewStats();
    return res.json(stats);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function getMatchMonitor(req, res) {
  try {
    const monitor = await adminDashboardService.getMatchMonitor();
    return res.json(monitor);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function listUsersAdmin(req, res) {
  try {
    const { search = "", page = "1", limit = "20" } = req.query;
    const result = await adminDashboardService.listUsers({ search, page: Number(page) || 1, limit: Number(limit) || 20 });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── Banners ────────────────────────────────────────────────────

async function uploadBannerImage(req, res) {
  if (!req.file) return res.status(400).json({ error: "image file is required" });
  try {
    const { url, publicId } = await cloudinaryService.uploadImage(req.file.buffer, req.file.mimetype);
    return res.json({ url, publicId });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function createBanner(req, res) {
  const {
    title, image_url, image_public_id,
    link_type = "none", link_value, link_meta,
    placements, display_order, is_active,
  } = req.body;

  if (!title?.trim() || !image_url || !image_public_id) {
    return res.status(400).json({ error: "title, image_url and image_public_id are required" });
  }
  if (!BANNER_LINK_TYPES.includes(link_type)) {
    return res.status(400).json({ error: `link_type must be one of: ${BANNER_LINK_TYPES.join(", ")}` });
  }
  if (!Array.isArray(placements) || placements.length === 0) {
    return res.status(400).json({ error: "placements must be a non-empty array" });
  }

  const { data, error } = await supabase
    .from("banners")
    .insert({
      title: title.trim(),
      image_url,
      image_public_id,
      link_type,
      link_value: link_value ?? null,
      link_meta: link_meta ?? null,
      placements,
      display_order: Number(display_order) || 0,
      is_active: is_active ?? true,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ banner: data });
}

async function listBannersAdmin(req, res) {
  const { data, error } = await supabase
    .from("banners")
    .select("*")
    .order("display_order", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ banners: data ?? [] });
}

async function updateBanner(req, res) {
  const { id } = req.params;
  const {
    title, image_url, image_public_id,
    link_type, link_value, link_meta,
    placements, display_order, is_active,
  } = req.body;

  if (link_type && !BANNER_LINK_TYPES.includes(link_type)) {
    return res.status(400).json({ error: `link_type must be one of: ${BANNER_LINK_TYPES.join(", ")}` });
  }
  if (placements !== undefined && (!Array.isArray(placements) || placements.length === 0)) {
    return res.status(400).json({ error: "placements must be a non-empty array" });
  }

  const { data: existing, error: fetchError } = await supabase
    .from("banners")
    .select("image_public_id")
    .eq("id", id)
    .single();
  if (fetchError) return res.status(404).json({ error: "banner not found" });

  const updates = { updated_at: new Date().toISOString() };
  if (title          !== undefined) updates.title          = title.trim();
  if (image_url      !== undefined) updates.image_url      = image_url;
  if (image_public_id !== undefined) updates.image_public_id = image_public_id;
  if (link_type      !== undefined) updates.link_type      = link_type;
  if (link_value     !== undefined) updates.link_value     = link_value ?? null;
  if (link_meta      !== undefined) updates.link_meta      = link_meta ?? null;
  if (placements     !== undefined) updates.placements     = placements;
  if (display_order  !== undefined) updates.display_order  = Number(display_order) || 0;
  if (is_active      !== undefined) updates.is_active      = is_active;

  const { data, error } = await supabase
    .from("banners")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // If the image was replaced, clean up the old Cloudinary asset.
  if (image_public_id && image_public_id !== existing.image_public_id) {
    await cloudinaryService.deleteImage(existing.image_public_id);
  }

  return res.json({ banner: data });
}

async function reorderBanners(req, res) {
  const { order } = req.body;
  if (!Array.isArray(order) || order.length === 0) {
    return res.status(400).json({ error: "order must be a non-empty array of banner ids" });
  }

  for (let i = 0; i < order.length; i++) {
    const { error } = await supabase
      .from("banners")
      .update({ display_order: i, updated_at: new Date().toISOString() })
      .eq("id", order[i]);
    if (error) return res.status(500).json({ error: error.message });
  }

  return res.json({ success: true });
}

async function deleteBanner(req, res) {
  const { id } = req.params;

  const { data: existing, error: fetchError } = await supabase
    .from("banners")
    .select("image_public_id")
    .eq("id", id)
    .single();
  if (fetchError) return res.status(404).json({ error: "banner not found" });

  const { error } = await supabase.from("banners").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });

  await cloudinaryService.deleteImage(existing.image_public_id);
  return res.json({ success: true });
}

module.exports = {
  createNotification,
  listNotificationsAdmin,
  deleteNotification,
  createExpertPrediction,
  updateExpertPrediction,
  deleteExpertPrediction,
  listExpertPredictionsAdmin,
  getUpcomingMatchesPicker,
  getOverview,
  getMatchMonitor,
  listUsersAdmin,
  uploadBannerImage,
  createBanner,
  listBannersAdmin,
  updateBanner,
  reorderBanners,
  deleteBanner,
};
