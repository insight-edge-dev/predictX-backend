/**
 * pushService.js — Expo Push Notification sender.
 *
 * sendPushNotifications(tokens, title, body, data)
 *   Batches up to 100 tokens per Expo API request. Automatically removes
 *   stale DeviceNotRegistered tokens from push_tokens table.
 *
 * getTokensForPref(preference)
 *   Returns all Expo push tokens for users with the given preference enabled.
 *   preference: 'match_alerts' | 'prediction_results' | 'live_score' | 'admin_broadcasts'
 *
 * getTokensForUsers(userIds, preference)
 *   Returns tokens for a specific set of user IDs, optionally filtered by preference.
 */

const supabase    = require("../config/supabase");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const BATCH_SIZE    = 100;

async function sendPushNotifications(tokens, title, body, data = {}) {
  if (!tokens?.length) return;

  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    const batch = tokens.slice(i, i + BATCH_SIZE);
    const messages = batch.map(token => ({
      to:    token,
      title,
      body,
      data,
      sound: "default",
    }));

    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept":       "application/json",
        },
        body: JSON.stringify(messages),
      });

      if (!res.ok) {
        console.warn("[Push] Expo API error:", res.status, await res.text());
        continue;
      }

      const json = await res.json();
      const stale = [];

      for (let j = 0; j < (json.data?.length ?? 0); j++) {
        const ticket = json.data[j];
        if (ticket?.status === "error" && ticket?.details?.error === "DeviceNotRegistered") {
          stale.push(batch[j]);
        }
      }

      if (stale.length) {
        await supabase.from("push_tokens").delete().in("token", stale);
        console.log(`[Push] removed ${stale.length} stale token(s)`);
      }
    } catch (e) {
      console.warn("[Push] batch send error:", e.message);
    }
  }
}

async function getTokensForPref(preference) {
  const { data: prefs, error: e1 } = await supabase
    .from("user_notification_preferences")
    .select("user_id")
    .eq(preference, true);

  if (e1 || !prefs?.length) return [];

  const userIds = prefs.map(p => p.user_id);

  const { data: tokens, error: e2 } = await supabase
    .from("push_tokens")
    .select("token")
    .in("user_id", userIds);

  if (e2) return [];
  return tokens?.map(r => r.token) ?? [];
}

async function getTokensForUsers(userIds, preference) {
  if (!userIds?.length) return [];

  const { data: prefs, error: e1 } = await supabase
    .from("user_notification_preferences")
    .select("user_id")
    .in("user_id", userIds)
    .eq(preference, true);

  if (e1 || !prefs?.length) return [];

  const allowedIds = prefs.map(p => p.user_id);

  const { data: tokens, error: e2 } = await supabase
    .from("push_tokens")
    .select("token")
    .in("user_id", allowedIds);

  if (e2) return [];
  return tokens?.map(r => r.token) ?? [];
}

/**
 * Returns push tokens for a named broadcast segment.
 * All segments still respect the user's admin_broadcasts preference.
 *
 * segment: 'all' | 'android' | 'ios' | 'active_7d'
 */
async function getTokensForSegment(segment = "all") {
  if (segment === "android" || segment === "ios") {
    const { data: prefs } = await supabase
      .from("user_notification_preferences")
      .select("user_id")
      .eq("admin_broadcasts", true);
    if (!prefs?.length) return [];
    const userIds = prefs.map(p => p.user_id);
    const { data: tokens } = await supabase
      .from("push_tokens")
      .select("token")
      .in("user_id", userIds)
      .eq("platform", segment);
    return tokens?.map(r => r.token) ?? [];
  }

  if (segment === "active_7d") {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    const { data: activeUsers } = await supabase
      .from("app_users")
      .select("id")
      .gte("last_active_at", weekAgo);
    if (!activeUsers?.length) return [];
    return getTokensForUsers(activeUsers.map(u => u.id), "admin_broadcasts");
  }

  return getTokensForPref("admin_broadcasts");
}

module.exports = { sendPushNotifications, getTokensForPref, getTokensForUsers, getTokensForSegment };
