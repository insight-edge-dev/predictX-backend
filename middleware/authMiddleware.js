const jwt = require("jsonwebtoken");

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or malformed Authorization header" });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.sub, phone: payload.phone };
    return next();
  } catch (e) {
    if (e.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired", code: "TOKEN_EXPIRED" });
    }
    return res.status(401).json({ error: "Invalid token" });
  }
}

// Like requireAuth but never rejects — sets req.user if a valid token is present,
// leaves req.user undefined if no token or invalid token. Used for endpoints that
// return public data but enrich the response for authenticated users (e.g. upvote counts).
async function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
      req.user = { id: payload.sub, phone: payload.phone };
    } catch {
      // invalid/expired token — treat as unauthenticated, don't error
    }
  }
  return next();
}

module.exports = { requireAuth, optionalAuth };
