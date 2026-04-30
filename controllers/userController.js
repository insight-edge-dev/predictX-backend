/**
 * userController.js — handlers for /api/user/* routes.
 * All routes require Supabase JWT (requireAuth middleware).
 * req.user is populated by authMiddleware before these run.
 */

const supabase = require("../config/supabase");
const { getCache, setCache, delCache, TTL, KEYS } = require("../services/cacheService");

// ── GET /api/user/profile ─────────────────────────────────────

async function getProfile(req, res) {
  const uid      = req.user.id;
  const cacheKey = KEYS.USER_PROFILE(uid);

  try {
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", uid)
      .single();

    if (error) {
      console.warn(`[User] getProfile(${uid}):`, error.message);
      return res.status(404).json({ error: "Profile not found" });
    }

    setCache(cacheKey, data, TTL.USER);
    return res.json(data);
  } catch (e) {
    console.error("[User] getProfile error:", e.message);
    return res.status(500).json({ error: "Failed to fetch profile" });
  }
}

// ── PATCH /api/user/profile ───────────────────────────────────

async function updateProfile(req, res) {
  const uid     = req.user.id;
  const updates = req.body;

  // Prevent overwriting the primary key
  delete updates.id;

  try {
    const { data, error } = await supabase
      .from("profiles")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("id", uid)
      .select()
      .single();

    if (error) {
      console.warn(`[User] updateProfile(${uid}):`, error.message);
      return res.status(400).json({ error: error.message });
    }

    // Invalidate cached profile
    delCache(KEYS.USER_PROFILE(uid));

    return res.json(data);
  } catch (e) {
    console.error("[User] updateProfile error:", e.message);
    return res.status(500).json({ error: "Failed to update profile" });
  }
}

// ── GET /api/user/favorites ───────────────────────────────────

async function getFavorites(req, res) {
  const uid      = req.user.id;
  const cacheKey = KEYS.USER_FAVORITES(uid);

  try {
    const cached = getCache(cacheKey);
    if (cached) return res.json({ favorites: cached });

    const { data, error } = await supabase
      .from("favorites")
      .select("*")
      .eq("user_id", uid)
      .order("created_at", { ascending: false });

    if (error) {
      console.warn(`[User] getFavorites(${uid}):`, error.message);
      return res.status(400).json({ error: error.message });
    }

    setCache(cacheKey, data, TTL.USER);
    return res.json({ favorites: data });
  } catch (e) {
    console.error("[User] getFavorites error:", e.message);
    return res.status(500).json({ favorites: [] });
  }
}

// ── POST /api/user/favorites ──────────────────────────────────

async function addFavorite(req, res) {
  const uid  = req.user.id;
  const { type, referenceId } = req.body; // type: "team" | "player" | "match"

  if (!type || !referenceId) {
    return res.status(400).json({ error: "type and referenceId are required" });
  }

  try {
    const { data, error } = await supabase
      .from("favorites")
      .upsert(
        { user_id: uid, type, reference_id: referenceId },
        { onConflict: "user_id,type,reference_id" },
      )
      .select()
      .single();

    if (error) {
      console.warn(`[User] addFavorite(${uid}):`, error.message);
      return res.status(400).json({ error: error.message });
    }

    delCache(KEYS.USER_FAVORITES(uid));
    return res.status(201).json(data);
  } catch (e) {
    console.error("[User] addFavorite error:", e.message);
    return res.status(500).json({ error: "Failed to add favorite" });
  }
}

// ── GET /api/user/teams ───────────────────────────────────────

async function getUserTeams(req, res) {
  const uid = req.user.id;

  try {
    const { data, error } = await supabase
      .from("favorites")
      .select("reference_id, created_at")
      .eq("user_id", uid)
      .eq("type", "team");

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.json({ teams: data.map((r) => r.reference_id) });
  } catch (e) {
    console.error("[User] getUserTeams error:", e.message);
    return res.status(500).json({ teams: [] });
  }
}

module.exports = { getProfile, updateProfile, getFavorites, addFavorite, getUserTeams };
