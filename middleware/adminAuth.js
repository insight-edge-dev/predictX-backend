/**
 * adminAuth.js — simple middleware that checks x-admin-key header.
 * The key is set in .env as ADMIN_KEY.
 */

function adminAuth(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

module.exports = adminAuth;
