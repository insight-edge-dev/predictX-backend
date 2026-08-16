/**
 * wsService.js — WebSocket server for real-time live scores.
 *
 * Data source: hl_fixtures table (kept fresh by highlightlySyncService every 60s).
 *
 * Broadcasts two message types on each poll:
 *   { type: "leagues:live", ts, byLeague: { ipl: [...], bbl: [...], intl: [...], ... } }
 *   { type: "ipl:live",     ts, matches: [...] }   ← backward compat
 *
 * Adaptive polling:
 *   Any live match present  → 30 s
 *   No live matches         → 60 s
 */

const WebSocket = require("ws");
const storage   = require("./highlightlyStorageService");
const { getLeagueByHLId } = require("../config/highlightlyConfig");
const { LEAGUES } = require("../config/leaguesConfig");
const { delCache } = require("./cacheService");
const supabase  = require("../config/supabase");

const POLL_LIVE_MS   = 30_000;
const POLL_IDLE_MS   = 60_000;
const PING_MS        = 20_000;
const MAX_WS_CLIENTS =   200;
const MAX_PER_IP     =     5;

let wss                = null;
let pollTimer          = null;
let pingTimer          = null;
let lastIplPayload     = null;
let lastLeaguesPayload = null;

const _milestoneSent = new Map();
const _ipConnections = new Map();

// All known domestic league slugs — pre-init byLeague with empty arrays
const LEAGUE_SLUGS = Object.keys(LEAGUES);

// ── Milestone notifications ───────────────────────────────────

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
            const t1 = m.team1?.shortName ?? m.team1?.name ?? "";
            const t2 = m.team2?.shortName ?? m.team2?.name ?? "";
            queue.push({
              title: `${threshold} Wickets Down`,
              body:  `${t1 && t2 ? `${t1} vs ${t2}` : "Live match"} — ${threshold} wickets have fallen!`,
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

async function poll() {
  try {
    // Read today's fixtures from warehouse (kept fresh by syncTodayMatches every 60s)
    const allToday = await storage.getTodayFixtures();

    // Group by slug
    const byLeague = {};
    for (const slug of LEAGUE_SLUGS) byLeague[slug] = [];
    byLeague["intl"] = []; // international bilateral matches

    for (const fixture of allToday) {
      if (fixture.status !== "live") continue;

      // Map HL leagueId → config slug
      const conf       = fixture.leagueId ? getLeagueByHLId(String(fixture.leagueId)) : null;
      const targetSlug = conf?.slug ?? "intl";

      const m = {
        ...fixture,
        team1Short: fixture.team1?.shortName ?? "",
        team2Short: fixture.team2?.shortName ?? "",
      };

      if (!byLeague[targetSlug]) byLeague[targetSlug] = [];
      byLeague[targetSlug].push(m);

      // If this match just completed — evict milestone keys
      if (fixture.status === "completed") {
        for (const key of _milestoneSent.keys()) {
          if (key.startsWith(`${m.id}:`)) _milestoneSent.delete(key);
        }
        // Bust fixture cache
        if (conf?.slug) delCache(`league:fixtures:${conf.slug}`);
        // Persist result to Supabase match_results
        supabase.from("match_results").upsert({
          match_id:    String(m.id),
          league_slug: conf?.slug ?? "intl",
          data:        m,
        }, { onConflict: "match_id" }).catch(e =>
          console.warn("[WS] match_results upsert failed:", e.message)
        );
      }
    }

    const nowLive   = Object.values(byLeague).some(arr => arr.length > 0);
    const totalLive = Object.values(byLeague).reduce((s, a) => s + a.length, 0);

    const leaguesPayload = { type: "leagues:live", ts: Date.now(), byLeague };
    lastLeaguesPayload = leaguesPayload;
    broadcast(leaguesPayload);

    const iplPayload = { type: "ipl:live", ts: Date.now(), matches: byLeague.ipl ?? [] };
    lastIplPayload = iplPayload;
    broadcast(iplPayload);

    console.log(`[WS] broadcast — totalLive=${totalLive} clients=${clientCount()}`);

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
    const ip = req.socket.remoteAddress ?? "unknown";
    const ipCount = (_ipConnections.get(ip) ?? 0);
    if (ipCount >= MAX_PER_IP) {
      ws.close(1013, "Too many connections from your IP");
      return;
    }
    _ipConnections.set(ip, ipCount + 1);
    console.log(`[WS] client connected — total: ${clientCount() + 1}`);
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    safeSend(ws, JSON.stringify({ type: "ipl:hello", ts: Date.now() }));
    if (lastLeaguesPayload) safeSend(ws, JSON.stringify(lastLeaguesPayload));
    if (lastIplPayload)     safeSend(ws, JSON.stringify(lastIplPayload));

    ws.on("close", () => {
      const cur = _ipConnections.get(ip) ?? 1;
      if (cur <= 1) _ipConnections.delete(ip);
      else _ipConnections.set(ip, cur - 1);
      console.log(`[WS] client disconnected — total: ${clientCount()}`);
    });
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
