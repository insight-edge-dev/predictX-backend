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

const POLL_LIVE_MS =  10_000;   // 10 s when a match is live
const POLL_IDLE_MS =  60_000;   // 60 s when nothing is live
const PING_MS      =  20_000;

let wss              = null;
let pollTimer        = null;
let pingTimer        = null;
let lastIplPayload   = null;
let lastLeaguesPayload = null;

// ── Helpers ───────────────────────────────────────────────────

function clientCount() { return wss ? wss.clients.size : 0; }

function safeSend(ws, msg) {
  try { if (ws.readyState === WebSocket.OPEN) ws.send(msg); }
  catch (e) { console.warn("[WS] send error:", e.message); }
}

function broadcast(payload) {
  if (!wss || !wss.clients.size) return;
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) safeSend(client, msg);
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

// Build a season_id → league config lookup once (static)
const SEASON_TO_LEAGUE = {};
for (const league of Object.values(LEAGUES)) {
  SEASON_TO_LEAGUE[league.seasonId] = league;
}
const LEAGUE_SLUGS = Object.keys(LEAGUES);

async function poll() {
  try {
    const raw = await sm.getLivescores();
    const liveFixtures = Array.isArray(raw) ? raw : [];

    // Group normalized matches by league slug
    const byLeague = {};
    for (const slug of LEAGUE_SLUGS) byLeague[slug] = [];

    for (const fixture of liveFixtures) {
      const league = SEASON_TO_LEAGUE[fixture.season_id];
      if (!league) continue;

      const m = normalizeFixture(fixture);
      if (!m) continue;

      // If normalizer detected completion via statusText, persist result to
      // Supabase (survives restarts) + bust fixtures cache.
      if (m.status === "completed") {
        delCache(KEYS.LEAGUE_FIXTURES(league.slug));
        const { setCache } = require("./cacheService");
        setCache(`completed_match:${m.id}`, m, 24 * 60 * 60);
        // Upsert to Supabase so result survives backend restarts
        supabase.from("match_results").upsert({
          match_id:    String(m.id),
          league_slug: league.slug,
          data:        m,
        }, { onConflict: "match_id" }).then(() => {
          console.log(`[WS] match ${m.id} result saved to Supabase`);
          // Cleanup rows older than 90 days to keep the table lean
          const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
          supabase.from("match_results").delete().lt("created_at", cutoff)
            .then(({ count }) => { if (count) console.log(`[WS] cleaned ${count} old match_results rows`); })
            .catch(() => {});
        }).catch(e => console.error("[WS] Supabase upsert error:", e.message));
        continue; // don't include in live payload
      }

      byLeague[league.slug].push({
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
