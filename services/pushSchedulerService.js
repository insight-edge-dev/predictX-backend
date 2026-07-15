/**
 * pushSchedulerService.js — Match alert scheduler.
 *
 * Runs every 5 minutes. Finds matches starting in 25–35 minutes across
 * all leagues (cricket, football, international), then sends a push
 * notification to all users with match_alerts enabled.
 *
 * Deduplication: tracks sent alerts in-memory (resets on server restart).
 * Call startScheduler() once at server boot.
 */

const { LEAGUES } = require("../config/leaguesConfig");

const INTERVAL_MS  = 5 * 60 * 1000; // check every 5 minutes
const WINDOW_MIN   = 25 * 60 * 1000; // earliest: 25 min from now
const WINDOW_MAX   = 35 * 60 * 1000; // latest:   35 min from now

const _alertsSent = new Set(); // key: `alert:${matchId}` — cleared on restart

function _inWindow(dateStr) {
  if (!dateStr) return false;
  const delta = new Date(dateStr).getTime() - Date.now();
  return delta >= WINDOW_MIN && delta <= WINDOW_MAX;
}

async function _checkUpcoming() {
  const leagueSvc  = require("./leagueService");
  const footballSvc = require("./footballService");
  const intlSvc    = require("./internationalService");
  const { sendPushNotifications, getTokensForPref } = require("./pushService");

  const candidates = [];

  // ── Cricket leagues ───────────────────────────────────────────
  for (const league of Object.values(LEAGUES)) {
    try {
      const { upcoming } = await leagueSvc.getLeagueMatches(league);
      for (const m of (upcoming ?? [])) {
        const startTime = m.startsAt ?? m.starting_at ?? m.date ?? m.startsAtLocal;
        if (!_inWindow(startTime)) continue;
        candidates.push({
          id:    String(m.id),
          title: "Match Starting Soon",
          body:  `${m.team1?.shortName ?? m.team1?.name ?? "TBD"} vs ${m.team2?.shortName ?? m.team2?.name ?? "TBD"} — ${league.name} in 30 min`,
        });
      }
    } catch (e) {
      console.warn(`[PushScheduler] cricket ${league.slug}:`, e.message);
    }
  }

  // ── Football ──────────────────────────────────────────────────
  try {
    const { upcoming } = await footballSvc.getMatches();
    for (const m of (upcoming ?? [])) {
      const startTime = m.utcDate;
      if (!_inWindow(startTime)) continue;
      const home = m.homeTeam?.shortName ?? m.homeTeam?.name ?? "TBD";
      const away = m.awayTeam?.shortName ?? m.awayTeam?.name ?? "TBD";
      candidates.push({
        id:    String(m.id),
        title: "Match Starting Soon",
        body:  `${home} vs ${away} — FIFA World Cup in 30 min`,
      });
    }
  } catch (e) {
    console.warn("[PushScheduler] football:", e.message);
  }

  // ── International cricket ─────────────────────────────────────
  try {
    for (const bucket of await intlSvc.getActiveBuckets()) {
      const fixtures = await intlSvc.getBucketFixtures(bucket);
      for (const m of (fixtures ?? [])) {
        if (m.status !== "upcoming") continue;
        const startTime = m.startsAt ?? m.starting_at ?? m.date;
        if (!_inWindow(startTime)) continue;
        candidates.push({
          id:    String(m.id),
          title: "Match Starting Soon",
          body:  `${m.team1?.shortName ?? "TBD"} vs ${m.team2?.shortName ?? "TBD"} — ${bucket.name} in 30 min`,
        });
      }
    }
  } catch (e) {
    console.warn("[PushScheduler] international:", e.message);
  }

  const fresh = candidates.filter(c => !_alertsSent.has(`alert:${c.id}`));
  if (!fresh.length) return;

  const tokens = await getTokensForPref("match_alerts");
  if (!tokens.length) {
    fresh.forEach(c => _alertsSent.add(`alert:${c.id}`));
    return;
  }

  for (const c of fresh) {
    _alertsSent.add(`alert:${c.id}`);
    sendPushNotifications(tokens, c.title, c.body, { type: "match_alert", matchId: c.id })
      .catch(e => console.warn("[PushScheduler] send error:", e.message));
  }

  console.log(`[PushScheduler] sent alerts for ${fresh.length} match(es) to ${tokens.length} token(s)`);
}

function startScheduler() {
  _checkUpcoming().catch(e => console.warn("[PushScheduler] initial check error:", e.message));
  setInterval(
    () => _checkUpcoming().catch(e => console.warn("[PushScheduler] check error:", e.message)),
    INTERVAL_MS,
  );
  console.log("[PushScheduler] started — checking every 5 min");
}

module.exports = { startScheduler };
