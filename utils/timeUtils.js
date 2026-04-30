/**
 * timeUtils.js — date/time helpers
 */

/**
 * Format an ISO date string into "DD MMM YYYY, HH:MM AM/PM IST"
 */
function formatMatchDate(isoString) {
  if (!isoString) return "";
  try {
    return new Date(isoString).toLocaleString("en-IN", {
      timeZone:    "Asia/Kolkata",
      day:         "2-digit",
      month:       "short",
      year:        "numeric",
      hour:        "2-digit",
      minute:      "2-digit",
      hour12:      true,
    });
  } catch {
    return isoString;
  }
}

/**
 * Convert a raw CricketData date/dateTimeGMT into an ISO string.
 *
 * dateTimeGMT is always UTC but arrives WITHOUT a timezone marker,
 * e.g. "2026-04-06 08:30:00". Without explicit UTC treatment,
 * new Date() parses it as LOCAL time — producing a 5h30m error on
 * an IST machine (08:30 appears instead of 14:00).
 *
 * Fix: normalise to "YYYY-MM-DDTHH:mm:ssZ" before parsing.
 */
function toISODate(dateTimeGMT, dateFallback) {
  const raw = dateTimeGMT || dateFallback;
  if (!raw) return new Date().toISOString();
  try {
    // Force UTC: "2026-04-06 08:30:00" → "2026-04-06T08:30:00Z"
    const utc = raw.includes("T")
      ? (raw.endsWith("Z") ? raw : raw + "Z")
      : raw.replace(" ", "T") + "Z";
    return new Date(utc).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/**
 * Return HH:MM AM/PM in IST from an ISO string.
 */
function toISTTime(isoString) {
  if (!isoString) return "";
  try {
    return new Date(isoString).toLocaleTimeString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour:     "2-digit",
      minute:   "2-digit",
      hour12:   true,
    });
  } catch {
    return "";
  }
}

module.exports = { formatMatchDate, toISODate, toISTTime };
