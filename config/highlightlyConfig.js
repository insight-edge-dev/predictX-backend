/**
 * highlightlyConfig.js — Highlightly league registry.
 *
 * In Highlightly, every season of a league gets its own unique leagueId.
 * Run `node backend/scripts/discoverLeagueIds.js` to discover new IDs each year.
 *
 * Lookup pattern:
 *   getHLLeagueId('ipl', 2026)  → '52875307'
 *   getAllActiveLeagues()         → leagues with a currentSeason entry
 */

// ── Indian domestic cricket ───────────────────────────────────

const HL_INDIAN_LEAGUES = {
  ipl: {
    slug: 'ipl', name: 'Indian Premier League', short: 'IPL',
    country: 'IN', format: 'T20', currentSeason: 2026,
    seasons: {
      2020: '42370967', 2021: '43722632', 2022: '45444947',
      2023: '47076472', 2024: '49361342', 2025: '50747482', 2026: '52875307',
    },
  },
  tnpl: {
    slug: 'tnpl', name: 'Tamil Nadu Premier League', short: 'TNPL',
    country: 'IN', format: 'T20', currentSeason: 2026,
    seasons: {
      2021: '44156387', 2022: '45950697', 2023: '48285967',
      2024: '50387122', 2025: '52118852', 2026: '54187317',
    },
  },
  apl: {
    slug: 'apl', name: 'Andhra Premier League', short: 'APL',
    country: 'IN', format: 'T20', currentSeason: 2024,
    seasons: { 2022: '46348752', 2023: '48708347', 2024: '50392897' },
  },
  maharaja: {
    slug: 'maharaja', name: 'Maharaja T20 Trophy', short: 'Maharaja',
    country: 'IN', format: 'T20', currentSeason: 2026,
    seasons: {
      2022: '46459352', 2023: '48679612', 2024: '50662572', 2026: '53980852',
    },
  },
  jpl: {
    slug: 'jpl', name: 'Jharkhand Premier League', short: 'JPL',
    country: 'IN', format: 'T20', currentSeason: 2026,
    seasons: { 2026: '53918867' },
  },
  mppl: {
    slug: 'mppl', name: 'Madhya Pradesh Premier League', short: 'MPPL',
    country: 'IN', format: 'T20', currentSeason: 2026,
    seasons: { 2026: '53923592' },
  },
  wpl: {
    slug: 'wpl', name: "Women's Premier League", short: 'WPL',
    country: 'IN', format: 'T20', currentSeason: 2026,
    seasons: { 2023: '49398197', 2024: '51217602', 2026: '52852207' },
  },
  smat: {
    slug: 'smat', name: 'Syed Mushtaq Ali Trophy', short: 'SMAT',
    country: 'IN', format: 'T20', currentSeason: 2026,
    seasons: {
      2020: '43546722', 2021: '44806862', 2022: '46652167',
      2023: '48419492', 2024: '50604087', 2025: '52233512',
      // 2026: add HL ID here when discovered (expected ~Oct 2026)
    },
  },
  vijay_hazare: {
    slug: 'vijay_hazare', name: 'Vijay Hazare Trophy', short: 'VHT',
    country: 'IN', format: 'List A', currentSeason: 2026,
    seasons: {
      2020: '43781327', 2021: '44806897', 2022: '46652132',
      2023: '48419562', 2024: '50604122', 2025: '52233547',
      // 2026: add HL ID here when discovered (expected ~Nov 2026)
    },
  },
  ranji: {
    slug: 'ranji', name: 'Ranji Trophy', short: 'Ranji',
    country: 'IN', format: 'First Class', currentSeason: 2026,
    seasons: {
      2023: '48419632', 2024: '50603982', 2025: '52233477',
      // 2026: add HL ID here when discovered (expected ~Oct 2026, Elite Phase 1 starts Oct 11)
    },
  },
  duleep: {
    slug: 'duleep', name: 'Duleep Trophy', short: 'Duleep',
    country: 'IN', format: 'First Class', currentSeason: 2026,
    seasons: {
      2022: '46652097', 2023: '48348582', 2024: '50603947',
      2025: '52233407', 2026: '54125402',
    },
  },
  irani_cup: {
    slug: 'irani_cup', name: 'Irani Cup', short: 'Irani',
    country: 'IN', format: 'First Class', currentSeason: 2026,
    seasons: {
      // 2026-27 HL ID not yet released — run discoverLeagueIds.js in late Sep 2026
      // and add here. Auto-discovery will show it as hl_<id> until then.
    },
  },
  legends_league: {
    slug: 'legends_league', name: 'Legends League Cricket', short: 'LLC',
    country: 'IN', format: 'T20', currentSeason: 2023,
    seasons: { 2022: '46709427', 2023: '49301352' },
  },
};

// ── Global franchise T20 leagues ──────────────────────────────

const HL_FRANCHISE_LEAGUES = {
  bbl: {
    slug: 'bbl', name: 'Big Bash League', short: 'BBL',
    country: 'AU', format: 'T20', currentSeason: 2025,
    seasons: {
      2020: '42937057', 2021: '44437437', 2022: '46361947',
      2023: '48513362', 2024: '50507102', 2025: '52168832',
    },
  },
  psl: {
    slug: 'psl', name: 'Pakistan Super League', short: 'PSL',
    country: 'PK', format: 'T20', currentSeason: 2026,
    seasons: {
      2021: '45255107', 2022: '46624622', 2023: '49446182',
      2025: '50199557', 2026: '53050832',
    },
  },
  bpl: {
    slug: 'bpl', name: 'Bangladesh Premier League', short: 'BPL',
    country: 'BD', format: 'T20', currentSeason: 2025,
    seasons: {
      2021: '45384082', 2022: '47115742', 2023: '49429662',
      2024: '51082362', 2025: '53078692',
    },
  },
  gsl: {
    slug: 'gsl', name: 'Global Super League', short: 'GSL',
    country: 'WI', format: 'T20', currentSeason: 2026,
    seasons: { 2024: '51107037', 2025: '52040767', 2026: '53659412' },
  },
  sa20: {
    slug: 'sa20', name: 'SA20', short: 'SA20',
    country: 'ZA', format: 'T20', currentSeason: 2025,
    seasons: { 2025: '52298962' },
  },
  lpl: {
    slug: 'lpl', name: 'Lanka Premier League', short: 'LPL',
    country: 'LK', format: 'T20', currentSeason: 2026,
    seasons: {
      2020: '43307007', 2021: '45191897', 2022: '46358272',
      2023: '48400767', 2024: '49749667', 2026: '53806692',
    },
  },
  mlc: {
    slug: 'mlc', name: 'Major League Cricket', short: 'MLC',
    country: 'US', format: 'T20', currentSeason: 2026,
    seasons: {
      2023: '47521112', 2024: '50145412', 2025: '51869827', 2026: '53499602',
    },
  },
};

// ── England domestic ──────────────────────────────────────────

const HL_ENGLAND_LEAGUES = {
  t20blast: {
    slug: 't20blast', name: 'T20 Blast', short: 'T20 Blast',
    country: 'GB', format: 'T20', currentSeason: 2025,
    seasons: { 2025: '51126497' },
  },
  hundred_men: {
    slug: 'hundred_men', name: "The Hundred Men's Competition", short: 'Hundred',
    country: 'GB', format: 'T20', currentSeason: 2026,
    seasons: {
      2021: '43821542', 2022: '45470077', 2023: '47444987',
      2024: '49622372', 2025: '51485142', 2026: '53241302',
    },
  },
  hundred_women: {
    slug: 'hundred_women', name: "The Hundred Women's Competition", short: 'Hundred W',
    country: 'GB', format: 'T20', currentSeason: 2026,
    seasons: {
      2021: '43843207', 2022: '45470182', 2023: '47445022',
      2024: '49622442', 2025: '51485177', 2026: '53241897',
    },
  },
};

// ── Other international & bilateral ──────────────────────────

const HL_INTERNATIONAL_LEAGUES = {
  supersmash: {
    slug: 'supersmash', name: 'Super Smash', short: 'SS',
    country: 'NZ', format: 'T20', currentSeason: 2025,
    seasons: {
      2020: '43189582', 2021: '45136212', 2022: '46941792',
      2023: '49331662', 2024: '50839567', 2025: '52486947',
    },
  },
  ashes: {
    slug: 'ashes', name: 'The Ashes', short: 'Ashes',
    country: 'INTL', format: 'Test', currentSeason: 2025,
    seasons: { 2023: '46761437', 2025: '50946457' },
  },
};

// ── Combined export ───────────────────────────────────────────

const HL_CRICKET_LEAGUES = {
  ...HL_INDIAN_LEAGUES,
  ...HL_FRANCHISE_LEAGUES,
  ...HL_ENGLAND_LEAGUES,
  ...HL_INTERNATIONAL_LEAGUES,
};

// ── Football leagues ──────────────────────────────────────────

const HL_FOOTBALL_LEAGUES = {
  // ── Big 5 European Leagues ────────────────────────────────────
  isl: {
    slug: 'isl', name: 'Indian Super League', short: 'ISL',
    country: 'IN', id: '275657', currentSeason: 2026,
    seasons: [2020, 2021, 2022, 2023, 2024, 2025, 2026],
  },
  laliga: {
    slug: 'laliga', name: 'La Liga', short: 'La Liga',
    country: 'ES', id: '119924', currentSeason: 2026,
    seasons: [2024, 2025, 2026],
  },
  premier_league: {
    slug: 'premier_league', name: 'Premier League', short: 'EPL',
    country: 'GB-ENG', id: '33973', currentSeason: 2026,
    seasons: [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026],
  },
  bundesliga: {
    slug: 'bundesliga', name: 'Bundesliga', short: 'Bundesliga',
    country: 'DE', id: '67162', currentSeason: 2026,
    seasons: [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026],
  },
  serie_a: {
    slug: 'serie_a', name: 'Serie A', short: 'Serie A',
    country: 'IT', id: '115669', currentSeason: 2026,
    seasons: [2023, 2024, 2025, 2026],
  },
  ligue1: {
    slug: 'ligue1', name: 'Ligue 1', short: 'Ligue 1',
    country: 'FR', id: '52695', currentSeason: 2026,
    seasons: [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026],
  },

  // ── UEFA Club Competitions ────────────────────────────────────
  ucl: {
    slug: 'ucl', name: 'UEFA Champions League', short: 'UCL',
    country: 'World', id: '2486', currentSeason: 2026,
    seasons: [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026],
  },
  uel: {
    slug: 'uel', name: 'UEFA Europa League', short: 'UEL',
    country: 'World', id: '3337', currentSeason: 2026,
    seasons: [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026],
  },

  // ── Other European Leagues ────────────────────────────────────
  eredivisie: {
    slug: 'eredivisie', name: 'Eredivisie', short: 'Eredivisie',
    country: 'NL', id: '75672', currentSeason: 2026,
    seasons: [2023, 2024, 2025, 2026],
  },
  liga_portugal: {
    slug: 'liga_portugal', name: 'Primeira Liga', short: 'Liga PT',
    country: 'PT', id: '80778', currentSeason: 2026,
    seasons: [2023, 2024, 2025, 2026],
  },
  super_lig: {
    slug: 'super_lig', name: 'Süper Lig', short: 'Süper Lig',
    country: 'TR', id: '173537', currentSeason: 2026,
    seasons: [2023, 2024, 2025, 2026],
  },
  championship: {
    slug: 'championship', name: 'Championship', short: 'Championship',
    country: 'GB-ENG', id: '34824', currentSeason: 2026,
    seasons: [2024, 2025, 2026],
  },
  segunda: {
    slug: 'segunda', name: 'Segunda División', short: 'LaLiga 2',
    country: 'ES', id: '120775', currentSeason: 2026,
    seasons: [2024, 2025, 2026],
  },
  ligue2: {
    slug: 'ligue2', name: 'Ligue 2', short: 'Ligue 2',
    country: 'FR', id: '53546', currentSeason: 2026,
    seasons: [2024, 2025, 2026],
  },

  // ── Domestic Cups ─────────────────────────────────────────────
  fa_cup: {
    slug: 'fa_cup', name: 'FA Cup', short: 'FA Cup',
    country: 'GB-ENG', id: '39079', currentSeason: 2026,
    seasons: [2024, 2025, 2026],
  },
  league_cup: {
    slug: 'league_cup', name: 'League Cup', short: 'EFL Cup',
    country: 'GB-ENG', id: '41632', currentSeason: 2026,
    seasons: [2024, 2025, 2026],
  },
  copa_del_rey: {
    slug: 'copa_del_rey', name: 'Copa del Rey', short: 'Copa del Rey',
    country: 'ES', id: '122477', currentSeason: 2026,
    seasons: [2024, 2025, 2026],
  },
  dfb_pokal: {
    slug: 'dfb_pokal', name: 'DFB Pokal', short: 'DFB Pokal',
    country: 'DE', id: '69715', currentSeason: 2026,
    seasons: [2024, 2025, 2026],
  },
  coppa_italia: {
    slug: 'coppa_italia', name: 'Coppa Italia', short: 'Coppa Italia',
    country: 'IT', id: '117371', currentSeason: 2026,
    seasons: [2024, 2025, 2026],
  },

  // ── Americas ──────────────────────────────────────────────────
  mls: {
    slug: 'mls', name: 'Major League Soccer', short: 'MLS',
    country: 'US', id: '216087', currentSeason: 2026,
    seasons: [2024, 2025, 2026],
  },
  copa_america: {
    slug: 'copa_america', name: 'Copa America', short: 'Copa América',
    country: 'World', id: '8443', currentSeason: 2024,
    seasons: [2021, 2024],
  },

  // ── Asia ──────────────────────────────────────────────────────
  j_league: {
    slug: 'j_league', name: 'J1 League', short: 'J1 League',
    country: 'JP', id: '84182', currentSeason: 2027, // Highlightly uses END-year: 2027 = the 2026/27 season
    seasons: [2024, 2025, 2026, 2027],
  },
  k_league: {
    slug: 'k_league', name: 'K League 1', short: 'K League 1',
    country: 'KR', id: '249276', currentSeason: 2026,
    seasons: [2023, 2024, 2025, 2026],
  },
  i_league: {
    slug: 'i_league', name: 'I-League', short: 'I-League',
    country: 'IN', id: '276508', currentSeason: 2026,
    seasons: [2024, 2025, 2026],
  },
  afc_asian_cup: {
    slug: 'afc_asian_cup', name: 'AFC Asian Cup', short: 'Asian Cup',
    country: 'World', id: '6741', currentSeason: 2024,
    seasons: [2019, 2024],
  },

  // ── Oceania ───────────────────────────────────────────────────
  a_league: {
    slug: 'a_league', name: 'A-League', short: 'A-League',
    country: 'AU', id: '160772', currentSeason: 2026,
    seasons: [2023, 2024, 2025, 2026],
  },

  // ── Middle East ───────────────────────────────────────────────
  saudi_pro: {
    slug: 'saudi_pro', name: 'Saudi Pro League', short: 'Saudi Pro',
    country: 'SA', id: '262041', currentSeason: 2026,
    seasons: [2023, 2024, 2025, 2026],
  },

  // ── International ─────────────────────────────────────────────
  wc: {
    slug: 'wc', name: 'FIFA World Cup', short: 'WC',
    country: 'World', id: '1635', currentSeason: 2026,
    seasons: [2022, 2026],
  },
  euro: {
    slug: 'euro', name: 'UEFA European Championship', short: 'Euro',
    country: 'World', id: '4188', currentSeason: 2024,
    seasons: [2020, 2024],
  },
  afcon: {
    slug: 'afcon', name: 'Africa Cup of Nations', short: 'AFCON',
    country: 'World', id: '5890', currentSeason: 2025, // AFCON 2025 (Morocco) ran Dec 21 2025 – Jan 18 2026
    seasons: [2021, 2023, 2024, 2025],
  },
};

// ── Helper functions ──────────────────────────────────────────

function getHLLeague(slug) {
  return HL_CRICKET_LEAGUES[slug] ?? HL_FOOTBALL_LEAGUES[slug] ?? null;
}

function getHLLeagueId(slug, season) {
  const league = HL_CRICKET_LEAGUES[slug];
  if (!league) return null;
  return league.seasons[Number(season)] ?? null;
}

// Returns all cricket leagues that have a currentSeason leagueId
function getAllActiveLeagues() {
  return Object.values(HL_CRICKET_LEAGUES)
    .map(l => ({ ...l, currentLeagueId: l.seasons[l.currentSeason] }))
    .filter(l => l.currentLeagueId);
}

// Reverse lookup: find league config by Highlightly leagueId string
function getLeagueByHLId(hlLeagueId) {
  const id = String(hlLeagueId);
  for (const league of Object.values(HL_CRICKET_LEAGUES)) {
    for (const [season, leagueId] of Object.entries(league.seasons)) {
      if (leagueId === id) return { ...league, matchedSeason: Number(season) };
    }
  }
  return null;
}

module.exports = {
  HL_CRICKET_LEAGUES,
  HL_FOOTBALL_LEAGUES,
  HL_INDIAN_LEAGUES,
  HL_FRANCHISE_LEAGUES,
  HL_ENGLAND_LEAGUES,
  HL_INTERNATIONAL_LEAGUES,
  getHLLeague,
  getHLLeagueId,
  getAllActiveLeagues,
  getLeagueByHLId,
};
