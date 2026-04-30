/**
 * iplTeams.js — authoritative IPL 2026 team registry for the backend.
 *
 * Used by:
 *   normalizer.js  — shortName resolution + Cloudinary logo injection
 *   iplService.js  — IPL detection (IPL_SHORT_NAMES set)
 *
 * Logo URLs mirror the frontend src/constants/iplTeams.ts registry
 * so logos are consistent regardless of which layer resolves them.
 */

// ── Full name → shortName ─────────────────────────────────────

const TEAM_NAME_MAP = {
  "Chennai Super Kings":          "CSK",
  "Mumbai Indians":               "MI",
  "Royal Challengers Bengaluru":  "RCB",
  "Royal Challengers Bangalore":  "RCB",   // legacy spelling
  "Kolkata Knight Riders":        "KKR",
  "Sunrisers Hyderabad":          "SRH",
  "Delhi Capitals":               "DC",
  "Rajasthan Royals":             "RR",
  "Punjab Kings":                 "PBKS",
  "Gujarat Titans":               "GT",
  "Lucknow Super Giants":         "LSG",
};

// ── Cloudinary logo registry ──────────────────────────────────
// Permanent self-hosted URLs — no rate limits, no external dependency.

const IPL_LOGOS = {
  CSK:  "https://res.cloudinary.com/ddi8hisku/image/upload/v1774872219/nyssxzxvvu3ytk8jautr.png",
  MI:   "https://res.cloudinary.com/ddi8hisku/image/upload/v1774872387/gganxjkcxunvsjqtzqam.png",
  RCB:  "https://res.cloudinary.com/ddi8hisku/image/upload/v1774872474/xUS54-BA0dFZPMtbCiHkzQ_96x96_vqd9to.png",
  KKR:  "https://res.cloudinary.com/ddi8hisku/image/upload/v1774872538/asquivocg8is3cxzzbrg.png",
  SRH:  "https://res.cloudinary.com/ddi8hisku/image/upload/v1774872701/W0OCBYc05c5MFMrctF62kg_96x96_s7f5fd.png",
  DC:   "https://res.cloudinary.com/ddi8hisku/image/upload/v1774872758/HzUX6_c8j7pwBCetmct2FQ_96x96_jp47mi.png",
  RR:   "https://res.cloudinary.com/ddi8hisku/image/upload/v1774872898/GqIU6xhQAnCpy_Cbr2LZRA_96x96_woil2j.png",
  PBKS: "https://res.cloudinary.com/ddi8hisku/image/upload/v1774873038/XUAb4iA3XozYbH_cXQCryQ_96x96_zgfxfr.png",
  GT:   "https://res.cloudinary.com/ddi8hisku/image/upload/v1774873011/aTE8G7q-OcAobWvDd6sizQ_96x96_wshgvl.png",
  LSG:  "https://res.cloudinary.com/ddi8hisku/image/upload/v1774873098/OqrL0ztLy13FBpvuF6GCBQ_96x96_sthfpb.png",
};

// ── Known shortNames set (for isIPLMatch fast-path) ───────────

const IPL_SHORT_NAMES = new Set(Object.keys(IPL_LOGOS));

// ── Helpers ───────────────────────────────────────────────────

/**
 * normalizeIPLTeam(name) → shortName or null
 * Resolves a full team name to its canonical IPL short code.
 * Returns null for non-IPL teams.
 */
function normalizeIPLTeam(name) {
  if (!name) return null;
  // Direct lookup
  if (TEAM_NAME_MAP[name]) return TEAM_NAME_MAP[name];
  // Case-insensitive fallback
  const lower = name.toLowerCase();
  for (const [fullName, short] of Object.entries(TEAM_NAME_MAP)) {
    if (fullName.toLowerCase() === lower) return short;
  }
  return null;
}

/**
 * getIPLLogo(shortName) → Cloudinary URL or ""
 * Returns the permanent Cloudinary URL for a team. Empty string for unknowns.
 */
function getIPLLogo(shortName) {
  return IPL_LOGOS[shortName] || "";
}

module.exports = {
  TEAM_NAME_MAP,
  IPL_LOGOS,
  IPL_SHORT_NAMES,
  normalizeIPLTeam,
  getIPLLogo,
};
