require("dotenv").config();

const http        = require("http");
const express     = require("express");
const cors        = require("cors");
const compression = require("compression");
const rateLimit   = require("express-rate-limit");

const helmet           = require("helmet");
const footballRoutes   = require("./routes/footballRoutes");
const matchRoutes      = require("./routes/matchRoutes");
const adminRoutes      = require("./routes/adminRoutes");
const adminAuth        = require("./middleware/adminAuth");
const publicContentRoutes = require("./routes/publicContentRoutes");
const seriesRoutes     = require("./routes/seriesRoutes");
const playerRoutes     = require("./routes/playerRoutes");
const userRoutes       = require("./routes/userRoutes");
const iplRoutes        = require("./routes/iplRoutes");
const leagueRoutes     = require("./routes/leagueRoutes");
const tipsRoutes       = require("./routes/tipsRoutes");
const homeRoutes       = require("./routes/homeRoutes");
const predictionRoutes = require("./routes/predictionRoutes");
const smsRoutes        = require("./routes/smsRoutes");
const authRoutes       = require("./routes/authRoutes");
const venueRoutes      = require("./routes/venueRoutes");
const internationalRoutes = require("./routes/internationalRoutes");
const communityRoutes     = require("./routes/communityRoutes");
const highlightRoutes     = require("./routes/highlightRoutes");

const { getStats, flushCache }    = require("./services/cacheService");
const { resetIPLCache, getIPLFixtures } = require("./services/iplService");
const db                          = require("./services/dbService");
const wsService                   = require("./services/wsService");
const footballService             = require("./services/footballService");
const footballScheduler           = require("./services/footballSchedulerService");
const predictionScheduler         = require("./services/predictionSchedulerService");
const resolverService             = require("./services/resolverService");
const pushScheduler               = require("./services/pushSchedulerService");
const { dbWriteQueue }            = require("./services/dbWriteQueue");
const { getRecentJobs, getWorkerStatus } = require("./services/syncLogger");
const { highlightlyLimiter }      = require("./services/apiRateLimiter");

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 5000;

// ── Middleware ────────────────────────────────────────────────

app.use(compression());

// ── Rate limiting ─────────────────────────────────────────────
// General API: 120 req/min per IP (2/s burst) — covers normal mobile usage.
// Auth endpoints: 10 req/min per IP — prevents OTP brute-force.
// Admin endpoints: 30 req/min per IP — prevents admin-key brute-force.

const apiLimiter = rateLimit({
  windowMs:        60_000,
  max:             600,   // app fires 60+ league queries + predictions on startup
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: "Too many requests, please slow down." },
});

const adminLimiter = rateLimit({
  windowMs:        60_000,
  max:             30,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: "Too many admin requests, please slow down." },
});

const authLimiter = rateLimit({
  windowMs:        60_000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: "Too many auth attempts, please wait a minute." },
});

app.use("/api", apiLimiter);
app.use("/api/admin", adminLimiter);
app.use("/api/auth/send-otp",   authLimiter);
app.use("/api/auth/verify-otp", authLimiter);

const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map(o => o.trim())
  : ["http://localhost:5173", "http://localhost:3000"];
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());

app.use((req, _res, next) => {
  if (process.env.LOG_REQUESTS === "true") {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

// ── Routes ────────────────────────────────────────────────────

app.use("/api", footballRoutes);
app.use("/api", smsRoutes);
app.use("/api", authRoutes);
app.use("/api", adminRoutes);
app.use("/api", publicContentRoutes);
app.use("/api", homeRoutes);
app.use("/api", predictionRoutes);
app.use("/api", leagueRoutes);
app.use("/api", iplRoutes);
app.use("/api", tipsRoutes);
app.use("/api", matchRoutes);
app.use("/api", seriesRoutes);
app.use("/api", playerRoutes);
app.use("/api", userRoutes);
app.use("/api", venueRoutes);
app.use("/api", internationalRoutes);
app.use("/api", communityRoutes);
app.use("/api", highlightRoutes);

// ── Health check ──────────────────────────────────────────────
// Basic liveness probe (load balancers, uptime monitors)

app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

// Rich pipeline health — sync job history, queue depths, circuit state, worker liveness
app.get("/api/health", adminAuth, async (_req, res) => {
  try {
    const [recentJobs, worker] = await Promise.all([getRecentJobs(30), getWorkerStatus()]);
    res.json({
      status:    "ok",
      ts:        new Date().toISOString(),
      writeQueue: {
        depth:       dbWriteQueue.depth,
        circuitOpen: dbWriteQueue.isCircuitOpen,
      },
      apiLimiter: {
        queueDepth: highlightlyLimiter.queueDepth,
      },
      worker,
      recentJobs,
    });
  } catch (e) {
    res.status(500).json({ status: "error", error: e.message });
  }
});

// ── AdMob app-ads.txt verification ───────────────────────────
// Google crawls this to verify that this server owns the app.

app.get("/app-ads.txt", (_req, res) => {
  res.type("text/plain").send(
    "google.com, pub-4645762055732117, DIRECT, f08c47fec0942fa0\n"
  );
});

// ── Android App Links verification ───────────────────────────
// Android fetches this URL to verify that this server owns the app.
// SHA-256 fingerprint: get from Google Play Console → App signing → SHA-256 certificate fingerprint.

app.get("/.well-known/assetlinks.json", (_req, res) => {
  res.json([{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace:               "android_app",
      package_name:            "com.insideedge.cricvora",
      sha256_cert_fingerprints: [
        process.env.ANDROID_SHA256_FINGERPRINT || "REPLACE_WITH_SHA256_FROM_PLAY_CONSOLE",
      ],
    },
  }]);
});

// ── Deep link fallback: /match/:id ────────────────────────────
// Opened when app is NOT installed. Redirects to Play Store.

app.get("/match/:id", (req, res) => {
  const id     = (req.params.id ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
  const sport  = req.query.sport ?? "";
  const scheme = sport === "football"
    ? `predictx://(match-details)/${id}?sport=football`
    : `predictx://(match-details)/${id}`;

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>PredictX</title>
  <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0B0B0B;color:#fff;text-align:center;padding:24px}</style>
  <script>
    window.location.href = "${scheme}";
    setTimeout(function(){
      window.location.href = "https://play.google.com/store/apps/details?id=com.insideedge.cricvora";
    }, 1500);
  </script>
</head>
<body>
  <div>
    <h2>Opening PredictX…</h2>
    <p>If nothing happens, <a href="https://play.google.com/store/apps/details?id=com.insideedge.cricvora" style="color:#E6FF00">download the app</a>.</p>
  </div>
</body>
</html>`);
});

// ── Admin: flush all caches ───────────────────────────────────

app.post("/admin/cache/flush", adminAuth, async (_req, res) => {
  flushCache();
  await resetIPLCache();
  res.json({ message: "all caches flushed" });
});

// ── Admin: force-refresh IPL fixtures from Sportsmonks ───────

app.post("/admin/refresh-fixtures", adminAuth, async (_req, res) => {
  try {
    await resetIPLCache();
    const fixtures = await getIPLFixtures();
    res.json({ message: `fixtures refreshed — ${fixtures.length} matches loaded` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: force-refresh football fixtures/standings from football-data.org ──

app.post("/admin/refresh-football", adminAuth, async (_req, res) => {
  try {
    const result = await footballService.refreshFromAPI();
    res.json({ message: `football data refreshed — ${result.fixtures} fixtures, ${result.groups} groups synced`, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: reset match/squad/scorecard DB data ────────────────

app.post("/admin/reset-matches", adminAuth, async (_req, res) => {
  try {
    flushCache();
    await Promise.all([
      db.deleteAllMatches(),
      db.deleteAllSquads(),
      db.deleteCachedByPrefix("pred:"),
    ]);
    res.json({ message: "matches, squads, and predictions cleared from DB" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: delete squads with no players ─────────────────────

app.post("/admin/fix-empty-squads", adminAuth, async (_req, res) => {
  try {
    const supabase = require("./config/supabase");
    const { data, error } = await supabase.from("squads").select("match_id, data");
    if (error) return res.status(500).json({ error: error.message });

    const emptyIds = (data || [])
      .filter(row => !row.data?.team1Players?.length && !row.data?.team2Players?.length)
      .map(row => row.match_id);

    if (emptyIds.length === 0) return res.json({ message: "no empty squads found" });

    await supabase.from("squads").delete().in("match_id", emptyIds);
    flushCache();
    res.json({ message: `deleted ${emptyIds.length} empty squad(s)`, ids: emptyIds });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: raw Sportsmonks fixture probe ──────────────────────

app.get("/admin/probe-fixture/:id", adminAuth, async (req, res) => {
  try {
    const sm  = require("./services/sportmonksService");
    const raw = await sm.getFixtureDetail(Number(req.params.id));
    res.json(raw || { error: "not found" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 404 ───────────────────────────────────────────────────────

app.use((_req, res) => res.status(404).json({ error: "Not found" }));

app.use((err, _req, res, _next) => {
  console.error("[Server] unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

// ── Graceful shutdown ─────────────────────────────────────────

async function shutdown(signal) {
  console.log(`[Server] ${signal} — closing HTTP server`);
  server.close(async () => {
    // Drain any serving-path fire-and-forget writes still in the queue
    if (dbWriteQueue.depth > 0) {
      console.log(`[Server] draining write queue (${dbWriteQueue.depth} pending)...`);
      await new Promise(resolve => {
        const iv = setInterval(() => {
          if (dbWriteQueue.depth === 0) { clearInterval(iv); resolve(); }
        }, 100);
        setTimeout(() => { clearInterval(iv); resolve(); }, 10_000);
      });
    }
    console.log("[Server] shutdown complete");
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// ── Start ─────────────────────────────────────────────────────

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[Server] PredictX backend listening on 0.0.0.0:${PORT}`);
  console.log(`[Server] HIGHLIGHTLY_API_KEY: ${process.env.HIGHLIGHTLY_API_KEY ? process.env.HIGHLIGHTLY_API_KEY.slice(0, 8) + "…" : "MISSING — all cricket/football data degraded"}`);
  console.log(`[Server] CRICBUZZ_API_KEY:    ${process.env.CRICBUZZ_API_KEY   ? process.env.CRICBUZZ_API_KEY.slice(0, 8)   + "…" : "MISSING (news/rankings degraded)"}`);
  console.log(`[Server] SUPABASE_URL:        ${process.env.SUPABASE_URL || "MISSING"}`);
  console.log(`[Server] APIFOOTBALL_KEY:     ${process.env.APIFOOTBALL_KEY ? process.env.APIFOOTBALL_KEY.slice(0, 8) + "…" : "MISSING (football-data.org degraded)"}`);

  wsService.init(server);
  footballScheduler.start();
  predictionScheduler.start();
  resolverService.startResolver();
  pushScheduler.startScheduler();
  // highlightlySync runs in worker.js (separate process) — not started here

  // Pre-warm expensive caches so the first app open hits memory, not live computation.
  // Bundle warming also warms leagueCards, cricket matches, intl, football and news in one shot.
  // Delay gives the DB connection pool time to stabilise after cold start.
  const WARM_DELAY_MS = parseInt(process.env.WARM_DELAY_MS ?? "5000", 10);
  setTimeout(async () => {
    try {
      const homeRouteModule = require("./routes/homeRoutes");
      // Trigger bundle computation directly via the service layer
      const { LEAGUES } = require("./config/leaguesConfig");
      const leagueSvc   = require("./services/leagueService");
      const footballSvc = require("./services/footballService");
      const intlSvc     = require("./services/internationalService");
      const newsSvc     = require("./services/newsService");
      const { setCache } = require("./services/cacheService");

      const cricketLeagues = Object.values(LEAGUES);
      const [cricketResults, football, intlSeries, intlSchedule, news] =
        await Promise.all([
          Promise.all(cricketLeagues.map(l => leagueSvc.getLeagueMatches(l).then(d => ({ slug: l.slug, ...d })).catch(() => ({ slug: l.slug, live: [], upcoming: [], completed: [] })))),
          footballSvc.getMatches().catch(() => ({ live: [], upcoming: [], completed: [] })),
          intlSvc.getSeriesList().catch(() => []),
          intlSvc.getScheduleFixtures(7).catch(() => ({ live: [], today: [], upcoming: [] })),
          newsSvc.fetchCricketNews().catch(() => []),
        ]);

      const matches = {};
      for (const { slug, live, upcoming, completed } of cricketResults) {
        matches[slug] = { live: live ?? [], upcoming: upcoming ?? [], completed: completed ?? [] };
      }
      // leagueCards is intentionally excluded — computing it during startup warm fires
      // 16+ concurrent Supabase queries alongside fixture fetches, exhausting the
      // free-tier connection pool (60 conns) and causing getCachedDataByPrefix("pred:light:")
      // to return an empty Map. That empty result then caches for 1h, hiding real data.
      // Discovery fetches leagueCards separately via /api/home/league-cards, which runs
      // after the connection pool has settled.
      setCache("home:bundle:v1", { matches, football, intlSeries, intlSchedule, leagueCards: [], news }, 30);
      console.log(`[Warm] home bundle ready (${cricketResults.length} leagues, leagueCards fetched lazily)`);
    } catch (e) {
      console.warn("[Warm] home bundle failed:", e.message);
    }
  }, WARM_DELAY_MS);

  // Tips bundle is NOT warmed at startup — each league processes 30-100+
  // completed matches against Supabase. Warming all leagues simultaneously
  // exhausts the free-tier connection pool (60 conns). Tips cache fills
  // naturally as users visit the Tips tab (30-min NodeCache TTL keeps it warm).
});
