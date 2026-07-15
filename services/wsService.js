/**
 * wsService.js — WebSocket server for real-time live scores across all leagues.
 *
 * One Sportsmonks /livescores call per poll returns ALL live fixtures globally.
 * We group them by league season_id, normalize, and broadcast two message types:
 *
 *   { type: "leagues:live", ts, byLeague: { ipl: [...], bbl: [...], ... } }
 *   { type: "ipl:live",     ts, matches: [...] }   ← backward compat
 *
 * Adaptive polling:
 *   Any live match present  →  30 s
 *   No live matches         →  2 min  (catches match start quickly)
 */

const WebSocket = require("ws");
const sm        = require("./sportmonksService");
const { LEAGUES } = require("../config/leaguesConfig");
const { normalizeFixture } = require("./sportmonksNormalizer");
const { delCache, KEYS }   = require("./cacheService");
const supabase             = require("../config/supabase");

const POLL_LIVE_MS   =  10_000;   // 10 s when a match is live
const POLL_IDLE_MS   =  60_000;   // 60 s when nothing is live
const PING_MS        =  20_000;
const MAX_WS_CLIENTS =  200;      // hard cap — Supabase Realtime also has a 200-conn limit

let wss              = null;
let pollTimer        = null;
let pingTimer        = null;
let lastIplPayload   = null;
let lastLeaguesPayload = null;

// Track milestones already sent this session — key: `${matchId}:w${threshold}`
const _milestoneSent = new Map();

function _extractWickets(scoreStr) {
  if (!scoreStr) return null;
  const m = String(scoreStr).match(/\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

async function _checkMilestones(byLeague) {
  const pushSvc = require("./pushService");
  const queue   = [];

  for (const matches of Object.values(byLeague)) {
    for (const m of matches) {
      if (!m?.id) continue;
      const id = String(m.id);

      const w1 = _extractWickets(m.score1);
      const w2 = _extractWickets(m.score2);

      for (const [slot, w] of [["s1", w1], ["s2", w2]]) {
        if (w == null) continue;
        for (const threshold of [5, 8]) {
          const key = `${id}:${slot}:w${threshold}`;
          if (w >= threshold && !_milestoneSent.has(key)) {
            _milestoneSent.set(key, true);
            const t1 = m.team1Short ?? m.team1?.name ?? "";
            const t2 = m.team2Short ?? m.team2?.name ?? "";
            const teams = t1 && t2 ? `${t1} vs ${t2}` : "Live match";
            queue.push({
              title: `${threshold} Wickets Down`,
              body:  `${teams} — ${threshold} wickets have fallen!`,
              data:  { type: "live_score", matchId: id },
            });
          }
        }
      }
    }
  }

  if (!queue.length) return;

  const tokens = await pushSvc.getTokensForPref("live_score");
  if (!tokens.length) return;

  for (const notif of queue) {
    pushSvc.sendPushNotifications(tokens, notif.title, notif.body, notif.data);
  }
  console.log(`[WS] sent ${queue.length} milestone push(es) to ${tokens.length} token(s)`);
}

// ── Helpers ───────────────────────────────────────────────────

function clientCount() { return wss ? wss.clients.size : 0; }

function safeSend(ws, msg) {
  try { if (ws.readyState === WebSocket.OPEN) ws.send(msg); }
  catch (e) { console.warn("[WS] send error:", e.message); }
}

function broadcast(payload) {
  if (!wss || !wss.clients.size) return;
  const msg     = JSON.stringify(payload);
  const clients = [...wss.clients];
  let i = 0;
  function sendBatch() {
    const end = Math.min(i + 10, clients.length);
    while (i < end) safeSend(clients[i++], msg);
    if (i < clients.length) setImmediate(sendBatch);
  }
  setImmediate(sendBatch);
}

// ── Heartbeat ─────────────────────────────────────────────────

function heartbeat() {
  if (!wss) return;
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}

// ── Adaptive poll ─────────────────────────────────────────────

let _isLiveMode = false;

// Build a season_id → league config lookup once (static, covers all domestic tournaments)
const SEASON_TO_LEAGUE = {};
for (const league of Object.values(LEAGUES)) {
  SEASON_TO_LEAGUE[league.seasonId] = league;
}
const LEAGUE_SLUGS = Object.keys(LEAGUES);

// International bilateral buckets — keyed by stable Sportsmonks league_id.
// Using league_id (not season_id) so this works across season rollovers without code changes.
const INTL_LEAGUE_ID_TO_SLUG = {
  3:   "t20i",   // Twenty20 International (Men's)
  258: "wt20i",  // Twenty20 International Women
  261: "wodi",   // One Day International Women
};
const INTL_SLUGS = [...new Set(Object.values(INTL_LEAGUE_ID_TO_SLUG))];

async function poll() {
  try {
    const raw = await sm.getLivescores();
    const liveFixtures = Array.isArray(raw) ? raw : [];

    // Group normalized matches by league slug (domestic + international)
    const byLeague = {};
    for (const slug of LEAGUE_SLUGS)  byLeague[slug] = [];
    for (const slug of INTL_SLUGS)    byLeague[slug] = [];

    for (const fixture of liveFixtures) {
      // Try domestic league first (season_id lookup), then international fallback (league_id)
      const league    = SEASON_TO_LEAGUE[fixture.season_id];
      const intlSlug  = !league ? INTL_LEAGUE_ID_TO_SLUG[fixture.league_id] : null;
      const targetSlug = league?.slug ?? intlSlug;
      if (!targetSlug) continue;

      const m = normalizeFixture(fixture);
      if (!m) continue;

      // If normalizer detected completion via statusText, persist result to
      // Supabase (survives restarts) + bust fixtures cache.
      if (m.status === "completed") {
        if (league) {
          // Domestic league: bust the cached fixture list and persist to Supabase
          delCache(KEYS.LEAGUE_FIXTURES(league.slug));
          const { setCache } = require("./cacheService");
          setCache(`completed_match:${m.id}`, m, 24 * 60 * 60);
          supabase.from("match_results").upsert({
            match_id:    String(m.id),
            league_slug: league.slug,
            data:        m,
          }, { onConflict: "match_id" }).then(() => {
            console.log(`[WS] match ${m.id} result saved to Supabase`);
            const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
            supabase.from("match_results").delete().lt("created_at", cutoff)
              .then(({ count }) => { if (count) console.log(`[WS] cleaned ${count} old match_results rows`); })
              .catch(() => {});
          }).catch(e => console.error("[WS] Supabase upsert error:", e.message));
        } else {
          // International match: bust the bucket fixture cache so schedule picks it up
          delCache(`intl:series:list:${intlSlug}`);
          delCache("intl:schedule");
          console.log(`[WS] intl match ${m.id} completed — busted ${intlSlug} cache`);
        }
        continue; // don't include in live payload
      }

      byLeague[targetSlug].push({
        ...m,
        status:     "live",
        team1Short: m.team1?.shortName ?? "",
        team2Short: m.team2?.shortName ?? "",
      });
    }

    const nowLive = Object.values(byLeague).some(arr => arr.length > 0);
    const totalLive = Object.values(byLeague).reduce((s, a) => s + a.length, 0);

    // ── Broadcast 1: unified multi-league payload ────────────
    const leaguesPayload = { type: "leagues:live", ts: Date.now(), byLeague };
    lastLeaguesPayload = leaguesPayload;
    broadcast(leaguesPayload);

    // ── Broadcast 2: backward-compat ipl:live ────────────────
    const iplPayload = { type: "ipl:live", ts: Date.now(), matches: byLeague.ipl ?? [] };
    lastIplPayload = iplPayload;
    broadcast(iplPayload);

    console.log(`[WS] broadcast — totalLive=${totalLive} clients=${clientCount()}`);

    // Check for wicket milestones and push to subscribed users
    if (nowLive) {
      _checkMilestones(byLeague).catch(e => console.warn("[WS] milestone push error:", e.message));
    }

    if (nowLive !== _isLiveMode) {
      _isLiveMode = nowLive;
      _reschedule();
    }
  } catch (e) {
    console.error("[WS] poll error:", e.message);
  }
}

function _reschedule() {
  if (pollTimer) clearInterval(pollTimer);
  const interval = _isLiveMode ? POLL_LIVE_MS : POLL_IDLE_MS;
  console.log(`[WS] adaptive poll: ${interval / 1000}s (live=${_isLiveMode})`);
  pollTimer = setInterval(
    () => poll().catch(e => console.error("[WS] poll error:", e.message)),
    interval,
  );
}

function startPolling() {
  if (pollTimer) return;
  poll().catch(e => console.error("[WS] initial poll error:", e.message));
  _reschedule();
}

// ── Init ──────────────────────────────────────────────────────

function init(server) {
  wss = new WebSocket.Server({ server, path: "/ws" });
  pingTimer = setInterval(heartbeat, PING_MS);

  wss.on("connection", (ws, req) => {
    if (clientCount() >= MAX_WS_CLIENTS) {
      ws.close(1013, "Server capacity reached");
      return;
    }
    const ip = req.socket.remoteAddress;
    console.log(`[WS] client connected (${ip}) — total: ${clientCount()}`);
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    safeSend(ws, JSON.stringify({ type: "ipl:hello", ts: Date.now() }));
    // Send last-known payloads so the new client has data immediately
    if (lastLeaguesPayload) safeSend(ws, JSON.stringify(lastLeaguesPayload));
    if (lastIplPayload)     safeSend(ws, JSON.stringify(lastIplPayload));

    ws.on("close", () => console.log(`[WS] client disconnected — total: ${clientCount()}`));
    ws.on("error", e => console.warn("[WS] client error:", e.message));
  });

  wss.on("close", () => { clearInterval(pingTimer); pingTimer = null; });

  startPolling();
  console.log("[WS] WebSocket server ready at ws://<host>/ws");
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  console.log("[WS] stopped");
}

module.exports = { init, poll, broadcast, stopPolling };
