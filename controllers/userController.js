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
      .from("app_users")
      .select("id, phone, display_name, avatar_url, favourite_teams, predictions_count, matches_tracked, created_at")
      .eq("id", uid)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Profile not found" });
    }

    const profile = {
      id:               data.id,
      phone:            data.phone,
      displayName:      data.display_name  ?? "",
      avatarUrl:        data.avatar_url    ?? null,
      favoriteTeams:    data.favourite_teams ?? [],
      predictionsCount: data.predictions_count ?? 0,
      matchesTracked:   data.matches_tracked   ?? 0,
      createdAt:        data.created_at,
    };

    setCache(cacheKey, profile, TTL.USER);
    return res.json(profile);
  } catch (e) {
    console.error("[User] getProfile error:", e.message);
    return res.status(500).json({ error: "Failed to fetch profile" });
  }
}

// ── PATCH /api/user/profile ───────────────────────────────────

async function updateProfile(req, res) {
  const uid     = req.user.id;
  const updates = req.body;
  delete updates.id;
  delete updates.phone;

  const payload = {};
  if (updates.displayName  !== undefined) payload.display_name    = updates.displayName;
  if (updates.avatarUrl    !== undefined) payload.avatar_url      = updates.avatarUrl;
  if (updates.favouriteTeams !== undefined) payload.favourite_teams = updates.favouriteTeams;
  payload.updated_at = new Date().toISOString();

  try {
    const { data, error } = await supabase
      .from("app_users")
      .update(payload)
      .eq("id", uid)
      .select("id, phone, display_name, avatar_url, favourite_teams, predictions_count, matches_tracked, created_at")
      .single();

    if (error) return res.status(400).json({ error: error.message });

    delCache(KEYS.USER_PROFILE(uid));

    return res.json({
      id:               data.id,
      phone:            data.phone,
      displayName:      data.display_name  ?? "",
      avatarUrl:        data.avatar_url    ?? null,
      favoriteTeams:    data.favourite_teams ?? [],
      predictionsCount: data.predictions_count ?? 0,
      matchesTracked:   data.matches_tracked   ?? 0,
      createdAt:        data.created_at,
    });
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

    if (error) return res.status(400).json({ error: error.message });

    setCache(cacheKey, data, TTL.USER);
    return res.json({ favorites: data });
  } catch (e) {
    console.error("[User] getFavorites error:", e.message);
    return res.status(500).json({ favorites: [] });
  }
}

// ── POST /api/user/favorites ──────────────────────────────────

async function addFavorite(req, res) {
  const uid = req.user.id;
  const { type, referenceId } = req.body;

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

    if (error) return res.status(400).json({ error: error.message });

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
      .select("reference_id")
      .eq("user_id", uid)
      .eq("type", "team");

    if (error) return res.status(400).json({ error: error.message });
    return res.json({ teams: data.map((r) => r.reference_id) });
  } catch (e) {
    console.error("[User] getUserTeams error:", e.message);
    return res.status(500).json({ teams: [] });
  }
}

module.exports = { getProfile, updateProfile, getFavorites, addFavorite, getUserTeams };
