/**
 * authMiddleware.js — verify Supabase JWT and attach req.user.
 *
 * Usage (route-level):
 *   router.get("/profile", requireAuth, userController.getProfile);
 *
 * On success: req.user = { id, email, ... }
 * On failure: 401 JSON response
 */

const supabase = require("../config/supabase");

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or malformed Authorization header" });
  }

  const token = authHeader.slice(7); // strip "Bearer "

  try {
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      console.warn("[Auth] invalid token:", error?.message);
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    req.user = data.user;
    return next();
  } catch (e) {
    console.error("[Auth] unexpected error:", e.message);
    return res.status(500).json({ error: "Authentication error" });
  }
}

module.exports = { requireAuth };
