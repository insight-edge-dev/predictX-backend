/**
 * leaguesConfig.js — Maps internal league slugs to Sportsmonks IDs.
 *
 * All IDs discovered from Sportsmonks API:
 *   GET /leagues  → league IDs
 *   GET /seasons  → season IDs per league
 *   GET /stages   → stage IDs per season
 */

const LEAGUES = {
  ipl: {
    slug:      'ipl',
    name:      'Indian Premier League',
    short:     'IPL',
    season:    '2026',
    leagueId:  1,
    seasonId:  1795,
    stageId:   6468,   // Regular season (for standings)
    playoffId: 6469,
    flag:      '🏏',
    country:   'India',
    format:    'T20',
  },
  bbl: {
    slug:      'bbl',
    name:      'Big Bash League',
    short:     'BBL',
    season:    '2025/26',
    leagueId:  5,
    seasonId:  1730,
    stageId:   6223,   // Regular season
    playoffId: 6224,
    flag:      '🦘',
    country:   'Australia',
    format:    'T20',
  },
  psl: {
    slug:      'psl',
    name:      'Pakistan Super League',
    short:     'PSL',
    season:    '2026',
    leagueId:  8,
    seasonId:  1802,
    stageId:   6487,
    playoffId: 6488,
    flag:      '🟢',
    country:   'Pakistan',
    format:    'T20',
  },
  bpl: {
    slug:      'bpl',
    name:      'Bangladesh Premier League',
    short:     'BPL',
    season:    '2025/26',
    leagueId:  9,
    seasonId:  1792,
    stageId:   6458,
    playoffId: 6459,
    flag:      '🟥',
    country:   'Bangladesh',
    format:    'T20',
  },
  t20blast: {
    slug:      't20blast',
    name:      'T20 Blast',
    short:     'T20 Blast',
    season:    '2026',
    leagueId:  13,
    seasonId:  1788,
    stageId:   6451,
    playoffId: 6453,
    flag:      '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
    country:   'England',
    format:    'T20',
  },
  t20wc: {
    slug:      't20wc',
    name:      "ICC Men's T20 World Cup",
    short:     'T20 WC',
    season:    '2026',
    leagueId:  17,
    seasonId:  1770,
    stageId:   6442,   // Group A (first group stage)
    playoffId: 6448,   // Play Offs
    flag:      '🌍',
    country:   'International',
    format:    'T20',
  },
  gsl: {
    slug:      'gsl',
    name:      'Global Super League',
    short:     'GSL',
    season:    '2026',
    leagueId:  426,
    seasonId:  1817,
    stageId:   6546,
    playoffId: 6547,
    flag:      '🌐',
    country:   'West Indies',
    format:    'T20',
  },
  csa_t20: {
    slug:      'csa_t20',
    name:      'CSA T20 Challenge',
    short:     'CSA T20',
    season:    '2025',
    leagueId:  10,
    seasonId:  1769,
    stageId:   6380,
    playoffId: 6381,
    flag:      '🦁',
    country:   'South Africa',
    format:    'T20',
  },
};

// Quick lookup by slug
function getLeague(slug) {
  return LEAGUES[slug] ?? null;
}

// Quick lookup by Sportsmonks league ID
function getLeagueBySmId(leagueId) {
  return Object.values(LEAGUES).find(l => l.leagueId === Number(leagueId)) ?? null;
}

module.exports = { LEAGUES, getLeague, getLeagueBySmId };
