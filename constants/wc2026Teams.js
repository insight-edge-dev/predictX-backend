/**
 * wc2026Teams.js — FIFA World Cup 2026 national team registry.
 *
 * Groups A-F: confirmed from the official FIFA draw / published schedule.
 * Groups G-L: best-available data (updated as fixtures confirmed).
 *
 * Key   = FIFA 3-letter code (used to look up teams from API fixture names)
 * group = group letter (A-L), used to bucket flat standings into groups.
 */

const WC2026_TEAMS = {
  // ── Group A ─────────────────────────────────────────────────
  MEX: { name: "Mexico",       shortName: "MEX", flag: "🇲🇽", color: "#006847", group: "A" },
  RSA: { name: "South Africa", shortName: "RSA", flag: "🇿🇦", color: "#007A4D", group: "A" },
  KOR: { name: "South Korea",  shortName: "KOR", flag: "🇰🇷", color: "#CD2E3A", group: "A" },
  CZE: { name: "Czechia",      shortName: "CZE", flag: "🇨🇿", color: "#D7141A", group: "A" },

  // ── Group B ─────────────────────────────────────────────────
  CAN: { name: "Canada",                shortName: "CAN", flag: "🇨🇦", color: "#FF0000", group: "B" },
  BIH: { name: "Bosnia & Herzegovina",  shortName: "BIH", flag: "🇧🇦", color: "#003DA5", group: "B" },
  QAT: { name: "Qatar",                 shortName: "QAT", flag: "🇶🇦", color: "#8D1B3D", group: "B" },
  SUI: { name: "Switzerland",           shortName: "SUI", flag: "🇨🇭", color: "#FF0000", group: "B" },

  // ── Group C ─────────────────────────────────────────────────
  BRA: { name: "Brazil",  shortName: "BRA", flag: "🇧🇷", color: "#009C3B", group: "C" },
  MAR: { name: "Morocco", shortName: "MAR", flag: "🇲🇦", color: "#C1272D", group: "C" },
  HTI: { name: "Haiti",   shortName: "HTI", flag: "🇭🇹", color: "#00209F", group: "C" },
  SCO: { name: "Scotland", shortName: "SCO", flag: "🏴󠁧󠁢󠁳󠁣󠁴󠁿", color: "#003399", group: "C" },

  // ── Group D ─────────────────────────────────────────────────
  USA: { name: "USA",       shortName: "USA", flag: "🇺🇸", color: "#002868", group: "D" },
  PAR: { name: "Paraguay",  shortName: "PAR", flag: "🇵🇾", color: "#0038A8", group: "D" },
  AUS: { name: "Australia", shortName: "AUS", flag: "🇦🇺", color: "#FFCD00", group: "D" },
  TUR: { name: "Türkiye",   shortName: "TUR", flag: "🇹🇷", color: "#E30A17", group: "D" },

  // ── Group E ─────────────────────────────────────────────────
  GER: { name: "Germany",      shortName: "GER", flag: "🇩🇪", color: "#000000", group: "E" },
  CUW: { name: "Curaçao",      shortName: "CUW", flag: "🇨🇼", color: "#003DA5", group: "E" },
  CIV: { name: "Ivory Coast",  shortName: "CIV", flag: "🇨🇮", color: "#F77F00", group: "E" },
  ECU: { name: "Ecuador",      shortName: "ECU", flag: "🇪🇨", color: "#FFD100", group: "E" },

  // ── Group F ─────────────────────────────────────────────────
  NED: { name: "Netherlands", shortName: "NED", flag: "🇳🇱", color: "#FF6600", group: "F" },
  JPN: { name: "Japan",       shortName: "JPN", flag: "🇯🇵", color: "#BC002D", group: "F" },
  SWE: { name: "Sweden",      shortName: "SWE", flag: "🇸🇪", color: "#006AA7", group: "F" },
  TUN: { name: "Tunisia",     shortName: "TUN", flag: "🇹🇳", color: "#E70013", group: "F" },

  // ── Group G ─────────────────────────────────────────────────
  ARG: { name: "Argentina", shortName: "ARG", flag: "🇦🇷", color: "#74ACDF", group: "G" },
  NGA: { name: "Nigeria",   shortName: "NGA", flag: "🇳🇬", color: "#008751", group: "G" },
  COL: { name: "Colombia",  shortName: "COL", flag: "🇨🇴", color: "#FCD116", group: "G" },
  NZL: { name: "New Zealand", shortName: "NZL", flag: "🇳🇿", color: "#000000", group: "G" },

  // ── Group H ─────────────────────────────────────────────────
  ESP: { name: "Spain",       shortName: "ESP", flag: "🇪🇸", color: "#AA151B", group: "H" },
  CPV: { name: "Cabo Verde",  shortName: "CPV", flag: "🇨🇻", color: "#003893", group: "H" },
  BEL: { name: "Belgium",     shortName: "BEL", flag: "🇧🇪", color: "#EF3340", group: "H" },
  ALG: { name: "Algeria",     shortName: "ALG", flag: "🇩🇿", color: "#006233", group: "H" },

  // ── Group I ─────────────────────────────────────────────────
  FRA: { name: "France",  shortName: "FRA", flag: "🇫🇷", color: "#002395", group: "I" },
  URU: { name: "Uruguay", shortName: "URU", flag: "🇺🇾", color: "#5AAAA6", group: "I" },
  SAU: { name: "Saudi Arabia", shortName: "SAU", flag: "🇸🇦", color: "#006C35", group: "I" },
  SRB: { name: "Serbia",  shortName: "SRB", flag: "🇷🇸", color: "#C6363C", group: "I" },

  // ── Group J ─────────────────────────────────────────────────
  ENG: { name: "England", shortName: "ENG", flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", color: "#CF081F", group: "J" },
  SEN: { name: "Senegal", shortName: "SEN", flag: "🇸🇳", color: "#00853F", group: "J" },
  IRN: { name: "Iran",    shortName: "IRN", flag: "🇮🇷", color: "#239F40", group: "J" },
  PAN: { name: "Panama",  shortName: "PAN", flag: "🇵🇦", color: "#DA121A", group: "J" },

  // ── Group K ─────────────────────────────────────────────────
  POR: { name: "Portugal",   shortName: "POR", flag: "🇵🇹", color: "#006600", group: "K" },
  EGY: { name: "Egypt",      shortName: "EGY", flag: "🇪🇬", color: "#CE1126", group: "K" },
  IDN: { name: "Indonesia",  shortName: "IDN", flag: "🇮🇩", color: "#CE1126", group: "K" },
  HND: { name: "Honduras",   shortName: "HND", flag: "🇭🇳", color: "#0073CF", group: "K" },

  // ── Group L ─────────────────────────────────────────────────
  ITA: { name: "Italy",       shortName: "ITA", flag: "🇮🇹", color: "#003399", group: "L" },
  CMR: { name: "Cameroon",    shortName: "CMR", flag: "🇨🇲", color: "#007A5E", group: "L" },
  CRO: { name: "Croatia",     shortName: "CRO", flag: "🇭🇷", color: "#FF0000", group: "L" },
  SLV: { name: "El Salvador", shortName: "SLV", flag: "🇸🇻", color: "#0F47AF", group: "L" },
};

// Additional name aliases for API matching (API may return different name formats)
const NAME_ALIASES = {
  "czech republic":     "CZE",
  "czechia":            "CZE",
  "bosnia":             "BIH",
  "bosnia and herzegovina": "BIH",
  "ivory coast":        "CIV",
  "cote d'ivoire":      "CIV",
  "côte d'ivoire":      "CIV",
  "cape verde":         "CPV",
  "cabo verde":         "CPV",
  "turkey":             "TUR",
  "turkiye":            "TUR",
  "türkiye":            "TUR",
  "curacao":            "CUW",
  "curaçao":            "CUW",
  "south africa":       "RSA",
  "south korea":        "KOR",
  "korea republic":     "KOR",
  "republic of korea":  "KOR",
  "saudi arabia":       "SAU",
  "new zealand":        "NZL",
  "el salvador":        "SLV",
  "usa":                "USA",
  "united states":      "USA",
  "england":            "ENG",
  "scotland":           "SCO",
  "haiti":              "HTI",
  "paraguay":           "PAR",
  "netherlands":        "NED",
  "holland":            "NED",
};

// By-name lookup (case-insensitive full name → team object)
const BY_NAME = {
  ...Object.fromEntries(Object.values(WC2026_TEAMS).map(t => [t.name.toLowerCase(), t])),
  ...Object.fromEntries(Object.entries(NAME_ALIASES).map(([alias, code]) => [alias, WC2026_TEAMS[code]])),
};

function getTeam(shortNameOrName) {
  if (!shortNameOrName) return null;
  return (
    WC2026_TEAMS[shortNameOrName.toUpperCase()] ??
    BY_NAME[shortNameOrName.toLowerCase()] ??
    null
  );
}

module.exports = { WC2026_TEAMS, BY_NAME, getTeam };
