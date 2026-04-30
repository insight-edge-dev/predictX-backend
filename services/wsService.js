/**
 * wsService.js — WebSocket server for real-time IPL live scores.
 *
 * Adaptive polling (Sportsmonks):
 *   Live match present  →  poll every 30 s
 *   No live match       →  poll every 10 min
 *
 * Data source: Sportsmonks /livescores filtered for IPL season.
 */

const WebSocket   = require("ws");
const { getIPLLiveMatches, getIPLMatches } = require("./iplService");

const POLL_LIVE_MS =  30_000; //  30 s during match
const POLL_IDLE_MS = 600_000; // 10 min when idle
const PING_MS      =  20_000; // keep-alive

let wss         = null;
let pollTimer   = null;
let pingTimer   = null;
let lastPayload = null;

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

async function poll() {
  try {
    const matches = await getIPLLiveMatches();
    const nowLive = matches.length > 0;

    if (matches.length) {
      const payload = { type: "ipl:live", ts: Date.now(), matches };
      lastPayload   = payload;
      console.log(`[WS] broadcast — live=${matches.length} clients=${clientCount()}`);
      broadcast(payload);
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
  console.log(`[WS] adaptive poll: ${interval / 1000}s interval (live=${_isLiveMode})`);
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
    if (lastPayload) safeSend(ws, JSON.stringify(lastPayload));
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
