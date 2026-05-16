/**
 * authRoutes.js — fully custom phone OTP authentication.
 *
 * POST /api/auth/send-otp     — rate-limited OTP via SMS API
 * POST /api/auth/verify-otp   — verify OTP, return access + refresh tokens
 * POST /api/auth/refresh       — rotate refresh token, return new access token
 * POST /api/auth/logout        — revoke refresh token
 * POST /api/auth/set-name      — save display name (protected)
 */

const express  = require("express");
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");
const crypto   = require("crypto");
const axios    = require("axios");
const supabase = require("../config/supabase");
const { requireAuth } = require("../middleware/authMiddleware");

const router = express.Router();

// ── Constants ─────────────────────────────────────────────────

const OTP_EXPIRY_MS      = 10 * 60 * 1000;    // 10 minutes
const OTP_WINDOW_MS      = 10 * 60 * 1000;    // rate-limit window
const OTP_MAX_SENDS      = 3;                  // sends per window
const OTP_MAX_ATTEMPTS   = 3;                  // failed verify attempts before lock
const ACCESS_TOKEN_TTL   = "15m";
const REFRESH_TOKEN_DAYS = 90;
const SMS_URL            = "https://jskbulkmarketing.in/app/smsapi/index.php";

// ── Demo account (for Google Play reviewer) ───────────────────
const DEMO_PHONE = "+910000000001";
const DEMO_OTP   = "123456";

// ── Helpers ───────────────────────────────────────────────────

function normalizePhone(raw) {
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return null;
}

function isValidPhone(phone) {
  return /^\+91[6-9]\d{9}$/.test(phone);
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function hashToken(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function generateAccessToken(userId, phone) {
  return jwt.sign(
    { sub: userId, phone },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL },
  );
}

function generateRefreshToken() {
  return crypto.randomBytes(48).toString("hex");
}

async function sendSms(mobile, otp) {
  const digits = mobile.replace(/\D/g, "");
  const number = digits.length > 10 ? digits.slice(-10) : digits;
  const msg = `Dear User, your OTP for Paco Innovations LLP login is ${otp}. OTP valid for 10 minutes. Please do not share it with anyone.`;
  await axios.get(SMS_URL, {
    params: {
      key:      process.env.SMS_API_KEY,
      campaign: process.env.SMS_CAMPAIGN_ID,
      routeid:  process.env.SMS_ROUTE_ID,
      type:     "text",
      contacts: number,
      senderid: process.env.SMS_SENDER_ID || "PACOIN",
      msg,
    },
    timeout: 10_000,
  });
}

// ── POST /api/auth/send-otp ───────────────────────────────────

router.post("/auth/send-otp", async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone || !isValidPhone(phone)) {
    return res.status(400).json({ error: "Invalid phone number" });
  }

  try {
    // Rate limit check
    const { data: existing } = await supabase
      .from("otp_requests")
      .select("send_count, window_start")
      .eq("phone", phone)
      .single();

    if (existing && phone !== DEMO_PHONE) {
      const windowAge = Date.now() - new Date(existing.window_start).getTime();
      if (windowAge < OTP_WINDOW_MS && existing.send_count >= OTP_MAX_SENDS) {
        const retryAfter = Math.ceil((OTP_WINDOW_MS - windowAge) / 1000);
        return res.status(429).json({
          error: `Too many requests. Try again in ${Math.ceil(retryAfter / 60)} minutes.`,
          retryAfter,
        });
      }
    }

    // Demo account — fixed OTP, no SMS
    const isDemo = phone === DEMO_PHONE;
    const otp     = isDemo ? DEMO_OTP : generateOtp();
    const hash    = await bcrypt.hash(otp, 10);
    // Demo OTP never expires (100 year expiry)
    const expires = isDemo
      ? new Date(Date.now() + 100 * 365 * 86400_000).toISOString()
      : new Date(Date.now() + OTP_EXPIRY_MS).toISOString();
    const windowReset = !existing || (Date.now() - new Date(existing.window_start).getTime()) >= OTP_WINDOW_MS;

    await supabase.from("otp_requests").upsert({
      phone,
      otp_hash:     hash,
      attempts:     0,
      send_count:   windowReset ? 1 : (existing.send_count + 1),
      window_start: windowReset ? new Date().toISOString() : existing.window_start,
      expires_at:   expires,
      created_at:   new Date().toISOString(),
    }, { onConflict: "phone" });

    if (!isDemo) await sendSms(phone, otp);
    console.log(`[Auth] OTP ${isDemo ? "(demo)" : "sent"} to ${phone}`);
    return res.json({ success: true, message: "OTP sent" });
  } catch (e) {
    console.error("[Auth] send-otp error:", e.message);
    return res.status(500).json({ error: "Failed to send OTP" });
  }
});

// ── POST /api/auth/verify-otp ─────────────────────────────────

router.post("/auth/verify-otp", async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const otp   = String(req.body.otp ?? "").trim();

  if (!phone || !isValidPhone(phone) || !/^\d{6}$/.test(otp)) {
    return res.status(400).json({ error: "Invalid phone or OTP format" });
  }

  try {
    const { data: otpRow } = await supabase
      .from("otp_requests")
      .select("*")
      .eq("phone", phone)
      .single();

    if (!otpRow) {
      return res.status(400).json({ error: "No OTP found. Please request a new one." });
    }

    if (new Date(otpRow.expires_at) < new Date()) {
      await supabase.from("otp_requests").delete().eq("phone", phone);
      return res.status(410).json({ error: "OTP expired. Please request a new one." });
    }

    if (otpRow.attempts >= OTP_MAX_ATTEMPTS) {
      return res.status(401).json({ error: "OTP locked. Please request a new one." });
    }

    const valid = await bcrypt.compare(otp, otpRow.otp_hash);

    if (!valid) {
      const attemptsLeft = OTP_MAX_ATTEMPTS - (otpRow.attempts + 1);
      await supabase.from("otp_requests")
        .update({ attempts: otpRow.attempts + 1 })
        .eq("phone", phone);
      return res.status(401).json({
        error: `Incorrect OTP. ${attemptsLeft} attempt${attemptsLeft !== 1 ? "s" : ""} left.`,
        attemptsLeft,
      });
    }

    // OTP valid — delete it immediately
    await supabase.from("otp_requests").delete().eq("phone", phone);

    // Upsert user
    const { data: user, error: upsertErr } = await supabase
      .from("app_users")
      .upsert({ phone, last_active_at: new Date().toISOString() }, { onConflict: "phone" })
      .select()
      .single();

    if (upsertErr || !user) {
      console.error("[Auth] upsert user error:", upsertErr?.message);
      return res.status(500).json({ error: "Failed to create user" });
    }

    const isNewUser = !user.display_name;

    // Issue tokens
    const accessToken  = generateAccessToken(user.id, user.phone);
    const rawRefresh   = generateRefreshToken();
    const refreshHash  = hashToken(rawRefresh);
    const refreshExp   = new Date(Date.now() + REFRESH_TOKEN_DAYS * 86400_000).toISOString();

    await supabase.from("refresh_tokens").insert({
      user_id:      user.id,
      token_hash:   refreshHash,
      expires_at:   refreshExp,
      last_used_at: new Date().toISOString(),
    });

    console.log(`[Auth] login success — user ${user.id} (new: ${isNewUser})`);

    return res.json({
      accessToken,
      refreshToken: rawRefresh,
      expiresIn:    900,
      user: {
        id:             user.id,
        phone:          user.phone,
        displayName:    user.display_name ?? null,
        favouriteTeams: user.favourite_teams ?? [],
        isNewUser,
      },
    });
  } catch (e) {
    console.error("[Auth] verify-otp error:", e.message);
    return res.status(500).json({ error: "Verification failed" });
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────

router.post("/auth/refresh", async (req, res) => {
  const rawToken = String(req.body.refreshToken ?? "").trim();
  if (!rawToken) return res.status(401).json({ error: "Missing refresh token" });

  const hash = hashToken(rawToken);

  try {
    const { data: tokenRow } = await supabase
      .from("refresh_tokens")
      .select("*, app_users(id, phone, display_name, favourite_teams)")
      .eq("token_hash", hash)
      .single();

    if (!tokenRow) {
      return res.status(401).json({ error: "Invalid or expired refresh token" });
    }

    if (new Date(tokenRow.expires_at) < new Date()) {
      await supabase.from("refresh_tokens").delete().eq("token_hash", hash);
      return res.status(401).json({ error: "Session expired. Please log in again." });
    }

    const user = tokenRow.app_users;
    if (!user) return res.status(401).json({ error: "User not found" });

    // Rotate — delete old, insert new
    await supabase.from("refresh_tokens").delete().eq("token_hash", hash);

    const newAccessToken  = generateAccessToken(user.id, user.phone);
    const newRawRefresh   = generateRefreshToken();
    const newRefreshHash  = hashToken(newRawRefresh);
    const newRefreshExp   = new Date(Date.now() + REFRESH_TOKEN_DAYS * 86400_000).toISOString();

    await supabase.from("refresh_tokens").insert({
      user_id:      user.id,
      token_hash:   newRefreshHash,
      expires_at:   newRefreshExp,
      last_used_at: new Date().toISOString(),
    });

    await supabase.from("app_users")
      .update({ last_active_at: new Date().toISOString() })
      .eq("id", user.id);

    return res.json({
      accessToken:  newAccessToken,
      refreshToken: newRawRefresh,
      expiresIn:    900,
      user: {
        id:             user.id,
        phone:          user.phone,
        displayName:    user.display_name ?? null,
        favouriteTeams: user.favourite_teams ?? [],
      },
    });
  } catch (e) {
    console.error("[Auth] refresh error:", e.message);
    return res.status(500).json({ error: "Token refresh failed" });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────

router.post("/auth/logout", requireAuth, async (req, res) => {
  const rawToken = String(req.body.refreshToken ?? "").trim();
  if (rawToken) {
    const hash = hashToken(rawToken);
    await supabase.from("refresh_tokens")
      .delete()
      .eq("token_hash", hash)
      .eq("user_id", req.user.id);
  }
  return res.json({ success: true });
});

// ── POST /api/auth/set-name ───────────────────────────────────

router.post("/auth/set-name", requireAuth, async (req, res) => {
  const name = String(req.body.displayName ?? "").trim();
  if (!name || name.length > 40) {
    return res.status(400).json({ error: "Name must be 1–40 characters" });
  }

  const { error } = await supabase
    .from("app_users")
    .update({ display_name: name, updated_at: new Date().toISOString() })
    .eq("id", req.user.id);

  if (error) return res.status(500).json({ error: "Failed to save name" });
  return res.json({ success: true, displayName: name });
});

// ── DELETE /api/auth/account ──────────────────────────────────

router.delete("/auth/account", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const phone  = req.user.phone;
  try {
    // Delete in order: tokens → favorites → otp → user
    await supabase.from("refresh_tokens").delete().eq("user_id", userId);
    await supabase.from("favorites").delete().eq("user_id", userId);
    if (phone) await supabase.from("otp_requests").delete().eq("phone", phone);
    const { error } = await supabase.from("app_users").delete().eq("id", userId);
    if (error) {
      console.error("[Auth] delete-account error:", error.message);
      return res.status(500).json({ error: "Failed to delete account" });
    }
    console.log(`[Auth] account deleted — user ${userId}`);
    return res.json({ success: true });
  } catch (e) {
    console.error("[Auth] delete-account error:", e.message);
    return res.status(500).json({ error: "Failed to delete account" });
  }
});

module.exports = router;
