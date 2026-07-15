const supabase = require("../config/supabase");
const { getCache, setCache, delCache, TTL, KEYS } = require("../services/cacheService");
const { uploadAvatar }                             = require("../services/cloudinaryService");

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

// ── POST /api/user/avatar ─────────────────────────────────────

async function uploadAvatarHandler(req, res) {
  const uid = req.user.id;

  if (!req.file) {
    return res.status(400).json({ error: "No image file provided" });
  }

  const { mimetype, buffer } = req.file;
  if (!["image/jpeg", "image/png", "image/webp", "image/heic"].includes(mimetype)) {
    return res.status(400).json({ error: "Unsupported image type. Use JPEG, PNG, or WebP." });
  }

  try {
    // Fetch current avatar public_id so we can delete it after uploading the new one
    const { data: current } = await supabase
      .from("app_users")
      .select("avatar_url, avatar_public_id")
      .eq("id", uid)
      .single();

    const oldPublicId = current?.avatar_public_id ?? null;

    const { url, publicId } = await uploadAvatar(buffer, mimetype, oldPublicId);

    await supabase
      .from("app_users")
      .update({ avatar_url: url, avatar_public_id: publicId, updated_at: new Date().toISOString() })
      .eq("id", uid);

    delCache(KEYS.USER_PROFILE(uid));

    return res.json({ avatarUrl: url });
  } catch (e) {
    console.error("[User] uploadAvatar error:", e.message);
    return res.status(500).json({ error: "Failed to upload avatar" });
  }
}

// ── POST /api/user/push-token ─────────────────────────────────

async function registerPushToken(req, res) {
  const uid = req.user.id;
  const { token, platform } = req.body;

  if (!token) return res.status(400).json({ error: "token is required" });
  if (!token.startsWith("ExponentPushToken[")) {
    return res.status(400).json({ error: "Invalid Expo push token" });
  }

  try {
    const { error } = await supabase
      .from("push_tokens")
      .upsert({ user_id: uid, token, platform: platform ?? "unknown" }, { onConflict: "token" });

    if (error) return res.status(400).json({ error: error.message });

    // Ensure default notification preferences row exists
    await supabase
      .from("user_notification_preferences")
      .upsert(
        { user_id: uid, match_alerts: true, prediction_results: true, live_score: true, admin_broadcasts: true, updated_at: new Date().toISOString() },
        { onConflict: "user_id", ignoreDuplicates: true },
      );

    return res.json({ success: true });
  } catch (e) {
    console.error("[User] registerPushToken error:", e.message);
    return res.status(500).json({ error: "Failed to register push token" });
  }
}

// ── DELETE /api/user/push-token ───────────────────────────────

async function removePushToken(req, res) {
  const uid = req.user.id;
  const { token } = req.body;

  if (!token) return res.status(400).json({ error: "token is required" });

  try {
    await supabase.from("push_tokens").delete().eq("user_id", uid).eq("token", token);
    return res.json({ success: true });
  } catch (e) {
    console.error("[User] removePushToken error:", e.message);
    return res.status(500).json({ error: "Failed to remove push token" });
  }
}

// ── GET /api/user/notification-prefs ─────────────────────────

async function getNotificationPrefs(req, res) {
  const uid = req.user.id;

  try {
    const { data, error } = await supabase
      .from("user_notification_preferences")
      .select("*")
      .eq("user_id", uid)
      .single();

    if (error && error.code !== "PGRST116") {
      return res.status(500).json({ error: "Failed to fetch preferences" });
    }

    return res.json({
      matchAlerts:       data?.match_alerts       ?? true,
      predictionResults: data?.prediction_results ?? true,
      liveScore:         data?.live_score         ?? true,
      adminBroadcasts:   data?.admin_broadcasts   ?? true,
    });
  } catch (e) {
    console.error("[User] getNotificationPrefs error:", e.message);
    return res.status(500).json({ error: "Failed to fetch preferences" });
  }
}

// ── PUT /api/user/notification-prefs ─────────────────────────

async function updateNotificationPrefs(req, res) {
  const uid = req.user.id;
  const { matchAlerts, predictionResults, liveScore, adminBroadcasts } = req.body;

  const payload = { user_id: uid, updated_at: new Date().toISOString() };
  if (matchAlerts       !== undefined) payload.match_alerts       = Boolean(matchAlerts);
  if (predictionResults !== undefined) payload.prediction_results = Boolean(predictionResults);
  if (liveScore         !== undefined) payload.live_score         = Boolean(liveScore);
  if (adminBroadcasts   !== undefined) payload.admin_broadcasts   = Boolean(adminBroadcasts);

  try {
    const { error } = await supabase
      .from("user_notification_preferences")
      .upsert(payload, { onConflict: "user_id" });

    if (error) return res.status(400).json({ error: error.message });
    return res.json({ success: true });
  } catch (e) {
    console.error("[User] updateNotificationPrefs error:", e.message);
    return res.status(500).json({ error: "Failed to update preferences" });
  }
}

module.exports = {
  getProfile,
  updateProfile,
  getFavorites,
  addFavorite,
  getUserTeams,
  uploadAvatarHandler,
  registerPushToken,
  removePushToken,
  getNotificationPrefs,
  updateNotificationPrefs,
};
