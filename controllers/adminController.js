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
const accuracyService       = require("../services/accuracyService");
const cloudinaryService    = require("../services/cloudinaryService");
const { delCache, KEYS, listEntries } = require("../services/cacheService");
const adminExternalService = require("../services/adminExternalService");

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

async function getSystemHealth(req, res) {
  try {
    const health = await adminDashboardService.getSystemHealth();
    return res.json(health);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function refreshLeague(req, res) {
  const { slug } = req.params;
  try {
    if (LEAGUES[slug]) {
      delCache(KEYS.LEAGUE_FIXTURES(slug));
      delCache(`league:live:${slug}`);
      return res.json({ refreshed: slug });
    }
    if (FOOTBALL_LEAGUES[slug]) {
      await footballService.refreshFromAPI();
      return res.json({ refreshed: slug });
    }
    const intlBucket = intlService.INTERNATIONAL_LEAGUES[slug];
    if (intlBucket) {
      delCache(KEYS.INTL_SERIES_LIST(slug));
      return res.json({ refreshed: slug });
    }
    return res.status(404).json({ error: `Unknown league/bucket slug: ${slug}` });
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
    starts_at, ends_at,
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
      starts_at: starts_at ?? null,
      ends_at:   ends_at   ?? null,
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
    starts_at, ends_at,
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
  if (starts_at      !== undefined) updates.starts_at      = starts_at ?? null;
  if (ends_at        !== undefined) updates.ends_at        = ends_at   ?? null;

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

  const results = await Promise.all(order.map((id, i) =>
    supabase.from("banners").update({ display_order: i, updated_at: new Date().toISOString() }).eq("id", id)
  ));
  const failed = results.find(r => r.error);
  if (failed) return res.status(500).json({ error: failed.error.message });

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

// ── Home Facts ("Did You Know?") ──────────────────────────────

const FACT_SPORTS = ["cricket", "football"];

function invalidateFactsCache(sport) {
  delCache(`home:facts:${sport}`);
}

async function createFact(req, res) {
  const { sport, icon, text, color, display_order, is_active } = req.body;

  if (!FACT_SPORTS.includes(sport)) {
    return res.status(400).json({ error: `sport must be one of: ${FACT_SPORTS.join(", ")}` });
  }
  if (!icon?.trim() || !text?.trim()) {
    return res.status(400).json({ error: "icon and text are required" });
  }

  const { data, error } = await supabase
    .from("home_facts")
    .insert({
      sport,
      icon: icon.trim(),
      text: text.trim(),
      color: color?.trim() || "#F59E0B",
      display_order: Number(display_order) || 0,
      is_active: is_active ?? true,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  invalidateFactsCache(sport);
  return res.json({ fact: data });
}

async function listFactsAdmin(req, res) {
  const { data, error } = await supabase
    .from("home_facts")
    .select("*")
    .order("sport", { ascending: true })
    .order("display_order", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ facts: data ?? [] });
}

async function updateFact(req, res) {
  const { id } = req.params;
  const { sport, icon, text, color, display_order, is_active } = req.body;

  if (sport !== undefined && !FACT_SPORTS.includes(sport)) {
    return res.status(400).json({ error: `sport must be one of: ${FACT_SPORTS.join(", ")}` });
  }

  const { data: existing, error: fetchError } = await supabase
    .from("home_facts")
    .select("sport")
    .eq("id", id)
    .single();
  if (fetchError) return res.status(404).json({ error: "fact not found" });

  const updates = {};
  if (sport         !== undefined) updates.sport         = sport;
  if (icon           !== undefined) updates.icon          = icon.trim();
  if (text           !== undefined) updates.text          = text.trim();
  if (color          !== undefined) updates.color         = color.trim();
  if (display_order !== undefined) updates.display_order = Number(display_order) || 0;
  if (is_active      !== undefined) updates.is_active     = is_active;

  const { data, error } = await supabase
    .from("home_facts")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  invalidateFactsCache(existing.sport);
  if (sport && sport !== existing.sport) invalidateFactsCache(sport);
  return res.json({ fact: data });
}

async function reorderFacts(req, res) {
  const { order } = req.body;
  if (!Array.isArray(order) || order.length === 0) {
    return res.status(400).json({ error: "order must be a non-empty array of fact ids" });
  }

  const { data: factRows, error: fetchErr } = await supabase
    .from("home_facts").select("id, sport").in("id", order);
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  const sports = new Set((factRows ?? []).map(r => r.sport));

  const results = await Promise.all(order.map((id, i) =>
    supabase.from("home_facts").update({ display_order: i }).eq("id", id)
  ));
  const failed = results.find(r => r.error);
  if (failed) return res.status(500).json({ error: failed.error.message });

  sports.forEach(invalidateFactsCache);
  return res.json({ success: true });
}

async function deleteFact(req, res) {
  const { id } = req.params;

  const { data: existing, error: fetchError } = await supabase
    .from("home_facts")
    .select("sport")
    .eq("id", id)
    .single();
  if (fetchError) return res.status(404).json({ error: "fact not found" });

  const { error } = await supabase.from("home_facts").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });

  invalidateFactsCache(existing.sport);
  return res.json({ success: true });
}

// ── League Priority ────────────────────────────────────────────

async function listLeaguePriority(req, res) {
  try {
    const { data: settings, error } = await supabase.from("league_settings").select("*");
    if (error) throw new Error(error.message);

    const prioMap = new Map((settings ?? []).map(s => [s.slug, s.priority]));
    const all = [...Object.values(LEAGUES), ...Object.values(FOOTBALL_LEAGUES)];
    const leagues = all.map(l => ({
      slug: l.slug, name: l.name, short: l.short, flag: l.flag, sport: l.sport ?? "cricket",
      priority: prioMap.get(l.slug) ?? 0,
    }));

    return res.json({ leagues });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function setLeaguePriority(req, res) {
  const { slug } = req.params;
  const { priority } = req.body;
  if (priority === undefined || Number.isNaN(Number(priority))) {
    return res.status(400).json({ error: "priority must be a number" });
  }

  const { error } = await supabase
    .from("league_settings")
    .upsert({ slug, priority: Number(priority), updated_at: new Date().toISOString() });

  if (error) return res.status(500).json({ error: error.message });

  delCache("all_leagues_raw");
  return res.json({ slug, priority: Number(priority) });
}

// ── Home Sections ──────────────────────────────────────────────

function invalidateSectionsCache() {
  delCache("home:sections");
}

async function listHomeSectionsAdmin(req, res) {
  const { data, error } = await supabase
    .from("home_sections")
    .select("*")
    .order("display_order", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ sections: data ?? [] });
}

async function setHomeSectionEnabled(req, res) {
  const { key } = req.params;
  const { enabled } = req.body;
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }

  const { data, error } = await supabase
    .from("home_sections")
    .update({ enabled })
    .eq("key", key)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  invalidateSectionsCache();
  return res.json({ section: data });
}

async function reorderHomeSections(req, res) {
  const { order } = req.body;
  if (!Array.isArray(order) || order.length === 0) {
    return res.status(400).json({ error: "order must be a non-empty array of section keys" });
  }

  const results = await Promise.all(order.map((key, i) =>
    supabase.from("home_sections").update({ display_order: i }).eq("key", key)
  ));
  const failed = results.find(r => r.error);
  if (failed) return res.status(500).json({ error: failed.error.message });

  invalidateSectionsCache();
  return res.json({ success: true });
}

// ── Prediction Accuracy ─────────────────────────────────────────

async function listAccuracyAdmin(req, res) {
  try {
    // Football accuracy is not per-league — the service fetches all fixtures in one
    // pool (no league filter). Compute it once and show as a single aggregate row.
    const cricketSlugs = [
      { slug: "global", name: "Global (all leagues)", group: "global" },
      ...Object.values(LEAGUES).map(l => ({ slug: l.slug, name: l.name, group: "cricket" })),
      ...Object.values(intlService.INTERNATIONAL_LEAGUES).map(b => ({ slug: b.slug, name: b.name, group: "cricket" })),
    ];

    const { data: overrides, error } = await supabase.from("accuracy_overrides").select("*");
    if (error) throw new Error(error.message);
    const overrideMap = new Map((overrides ?? []).map(o => [o.key, o.override_pct]));

    // Cricket rows — each has a meaningful per-league computation
    const cricketRows = await Promise.all(cricketSlugs.map(async ({ slug, name, group }) => {
      const computed = slug === "global"
        ? await accuracyService.computeGlobalAccuracy()
        : await accuracyService.computeLeagueAccuracy(slug);
      return {
        slug, name, group,
        computedPercentage: computed?.percentage ?? 0,
        sampleSize: computed?.total ?? 0,
        override: overrideMap.get(slug) ?? null,
      };
    }));

    // Football — one aggregate row (per-league breakdown would be identical for every slug)
    const footballComputed = await accuracyService.computeLeagueAccuracy(
      Object.keys(FOOTBALL_LEAGUES)[0] ?? "premier_league"
    );
    const footballRow = {
      slug: "football",
      name: "Football (all leagues)",
      group: "football",
      computedPercentage: footballComputed?.percentage ?? 0,
      sampleSize: footballComputed?.total ?? 0,
      override: overrideMap.get("football") ?? null,
    };

    return res.json({ rows: [...cricketRows, footballRow] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function setAccuracyOverride(req, res) {
  const { key } = req.params;
  const { override } = req.body;
  if (override !== null && Number.isNaN(Number(override))) {
    return res.status(400).json({ error: "override must be a number or null" });
  }

  try {
    await accuracyService.setOverride(key, override === null ? null : Number(override));
    invalidateLeagueCardsCache();
    return res.json({ key, override: override === null ? null : Number(override) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── League Cards (Discovery "PredictX Prediction" section) ──────

function invalidateLeagueCardsCache() {
  listEntries()
    .filter(e => e.key.startsWith("accuracy:league-cards:"))
    .forEach(e => delCache(e.key));
}

function allLeagueCardSlugs() {
  return [
    ...Object.values(LEAGUES).map(l => ({ slug: l.slug, name: l.name, short: l.short, flag: l.flag, sport: "cricket" })),
    ...Object.values(FOOTBALL_LEAGUES).map(l => ({ slug: l.slug, name: l.name, short: l.short, flag: l.flag, sport: "football" })),
    ...Object.values(intlService.INTERNATIONAL_LEAGUES).map(b => ({ slug: b.slug, name: b.name, short: b.short, flag: b.flag, sport: "cricket" })),
  ];
}

async function listLeagueCardSettingsAdmin(req, res) {
  try {
    const { data: settings, error } = await supabase.from("league_card_settings").select("*");
    if (error) throw new Error(error.message);
    const settingsMap = new Map((settings ?? []).map(s => [s.slug, s]));

    const cards = allLeagueCardSlugs().map((l, i) => {
      const s = settingsMap.get(l.slug);
      return {
        ...l,
        is_visible:    s ? s.is_visible : true,
        display_order: s ? s.display_order : i,
      };
    }).sort((a, b) => a.display_order - b.display_order);

    return res.json({ cards });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function setLeagueCardVisible(req, res) {
  const { slug } = req.params;
  const { visible } = req.body;
  if (typeof visible !== "boolean") {
    return res.status(400).json({ error: "visible must be a boolean" });
  }

  // Preserve display_order explicitly — an upsert that omits it would let a
  // brand-new row fall back to the table's DEFAULT 0 on this card's first
  // ever toggle, jumping it to the front unintentionally.
  const { data: existing } = await supabase
    .from("league_card_settings").select("display_order").eq("slug", slug).single();
  const fallbackOrder = allLeagueCardSlugs().findIndex(l => l.slug === slug);
  const displayOrder = existing ? existing.display_order : Math.max(fallbackOrder, 0);

  const { error } = await supabase
    .from("league_card_settings")
    .upsert({ slug, is_visible: visible, display_order: displayOrder, updated_at: new Date().toISOString() });

  if (error) return res.status(500).json({ error: error.message });
  invalidateLeagueCardsCache();
  return res.json({ slug, visible });
}

async function reorderLeagueCards(req, res) {
  const { order } = req.body;
  if (!Array.isArray(order) || order.length === 0) {
    return res.status(400).json({ error: "order must be a non-empty array of league slugs" });
  }

  const rows = order.map((slug, i) => ({ slug, display_order: i, updated_at: new Date().toISOString() }));
  const { error } = await supabase.from("league_card_settings").upsert(rows);
  if (error) return res.status(500).json({ error: error.message });

  invalidateLeagueCardsCache();
  return res.json({ success: true });
}

async function sendPushBroadcast(req, res) {
  const { title, body, data, segment = "all" } = req.body;
  if (!title?.trim() || !body?.trim()) {
    return res.status(400).json({ error: "title and body are required" });
  }

  try {
    const { sendPushNotifications, getTokensForSegment } = require("../services/pushService");
    const tokens = await getTokensForSegment(segment);

    sendPushNotifications(tokens, title.trim(), body.trim(), data ?? {})
      .catch(e => console.error("[Admin] push broadcast error:", e.message));

    return res.json({ queued: tokens.length, segment });
  } catch (e) {
    console.error("[Admin] sendPushBroadcast error:", e.message);
    return res.status(500).json({ error: "Failed to send broadcast" });
  }
}

async function getPredictionAnalytics(req, res) {
  try {
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();

    const [{ data: recent30d }, { data: allResolved }, { data: pollStats }] = await Promise.all([
      supabase.from("user_match_predictions").select("created_at, result, sport").gte("created_at", since30d).order("created_at", { ascending: true }),
      supabase.from("user_match_predictions").select("result").in("result", ["correct", "wrong"]),
      supabase.from("match_prediction_stats").select("team_a_name, team_b_name, team_a_count, team_b_count, total, updated_at").order("total", { ascending: false }).limit(50),
    ]);

    // Daily breakdown (last 30 days)
    const dailyMap = new Map();
    for (const row of recent30d ?? []) {
      const date = row.created_at.slice(0, 10);
      if (!dailyMap.has(date)) dailyMap.set(date, { date, total: 0, cricket: 0, football: 0, correct: 0, wrong: 0 });
      const d = dailyMap.get(date);
      d.total++;
      if (row.sport === "cricket") d.cricket++;
      else if (row.sport === "football") d.football++;
      if (row.result === "correct") d.correct++;
      else if (row.result === "wrong") d.wrong++;
    }
    const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));

    // Team popularity from poll stats
    const teamMap = new Map();
    for (const ps of pollStats ?? []) {
      if (ps.team_a_name) teamMap.set(ps.team_a_name, (teamMap.get(ps.team_a_name) ?? 0) + (ps.team_a_count ?? 0));
      if (ps.team_b_name) teamMap.set(ps.team_b_name, (teamMap.get(ps.team_b_name) ?? 0) + (ps.team_b_count ?? 0));
    }
    const teamStats = [...teamMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([team, predictions]) => ({ team, predictions }));

    // Overall accuracy (all-time)
    const correct = (allResolved ?? []).filter(r => r.result === "correct").length;
    const wrong   = (allResolved ?? []).filter(r => r.result === "wrong").length;

    // Most contested matches (closest 50/50 split)
    const recentMatches = (pollStats ?? [])
      .filter(ps => (ps.total ?? 0) >= 5)
      .map(ps => ({
        team_a: ps.team_a_name, team_b: ps.team_b_name,
        team_a_votes: ps.team_a_count ?? 0, team_b_votes: ps.team_b_count ?? 0,
        total: ps.total ?? 0,
        spread: ps.total > 0 ? Math.abs(50 - Math.round(((ps.team_a_count ?? 0) / ps.total) * 100)) : 50,
        updated_at: ps.updated_at,
      }))
      .sort((a, b) => a.spread - b.spread)
      .slice(0, 8);

    return res.json({
      daily,
      teamStats,
      overall: {
        totalLast30d: (recent30d ?? []).length,
        correct,
        wrong,
        accuracy: (correct + wrong) > 0 ? Math.round((correct / (correct + wrong)) * 100) : 0,
      },
      recentMatches,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function getUserDetail(req, res) {
  const { id } = req.params;
  try {
    const [{ data: user }, { data: predictions }, { data: token }] = await Promise.all([
      supabase.from("app_users").select("*").eq("id", id).maybeSingle(),
      supabase.from("user_match_predictions")
        .select("id, match_id, sport, team_a, team_b, predicted_winner, result, created_at")
        .eq("user_id", id).order("created_at", { ascending: false }).limit(20),
      supabase.from("push_tokens").select("token, platform").eq("user_id", id).maybeSingle(),
    ]);
    return res.json({ user: user ?? null, predictions: predictions ?? [], pushToken: token ?? null });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function getLeaderboardAdmin(req, res) {
  const period = req.query.period === "week" ? "week" : "all";
  const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
  try {
    const userPredictionService = require("../services/userPredictionService");
    const leaderboard = await userPredictionService.getLeaderboard(limit, period);
    return res.json({ leaderboard, period });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

const commentService = require("../services/commentService");

async function getAnalytics(req, res) {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 7), 90);
    const data = await adminDashboardService.getAnalytics({ days });
    return res.json(data);
  } catch (e) {
    console.error("[Admin] getAnalytics:", e.message);
    return res.status(500).json({ error: e.message });
  }
}

async function listCommentsAdmin(req, res) {
  try {
    const { contextType, page } = req.query;
    const result = await commentService.listCommentsAdmin({
      contextType: contextType || null,
      page: parseInt(page) || 1,
    });
    return res.json(result);
  } catch (e) {
    console.error("[Admin] listCommentsAdmin:", e.message);
    return res.status(500).json({ error: "Failed to fetch comments" });
  }
}

async function deleteCommentAdmin(req, res) {
  try {
    await commentService.deleteComment(req.params.id);
    return res.json({ success: true });
  } catch (e) {
    console.error("[Admin] deleteCommentAdmin:", e.message);
    return res.status(500).json({ error: "Failed to delete comment" });
  }
}

async function getExternalAnalytics(req, res) {
  try {
    const days = Math.min(90, Math.max(7, parseInt(req.query.days ?? '30', 10)));
    const data = await adminExternalService.getAllExternal(days);
    return res.json(data);
  } catch (e) {
    console.error("[Admin] getExternalAnalytics:", e.message);
    return res.status(500).json({ error: e.message });
  }
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
  getSystemHealth,
  refreshLeague,
  listUsersAdmin,
  uploadBannerImage,
  createBanner,
  listBannersAdmin,
  updateBanner,
  reorderBanners,
  deleteBanner,
  createFact,
  listFactsAdmin,
  updateFact,
  reorderFacts,
  deleteFact,
  listLeaguePriority,
  setLeaguePriority,
  listHomeSectionsAdmin,
  setHomeSectionEnabled,
  reorderHomeSections,
  listAccuracyAdmin,
  setAccuracyOverride,
  listLeagueCardSettingsAdmin,
  setLeagueCardVisible,
  reorderLeagueCards,
  listCommentsAdmin,
  deleteCommentAdmin,
  sendPushBroadcast,
  getPredictionAnalytics,
  getUserDetail,
  getLeaderboardAdmin,
  getAnalytics,
  getExternalAnalytics,
};
