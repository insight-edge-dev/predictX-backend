/**
 * adminExternalService.js
 *
 * Integrations: Google (Play Console + Firebase GA4) and Meta Ads.
 * All functions return { configured: false } when env vars are absent,
 * so the frontend can show setup instructions instead of crashing.
 *
 * Auth:
 *   - Google: service account JWT (RS256) → OAuth2 access token (55-min cache)
 *   - Meta:   long-lived user / system-user access token (env var)
 */

const jwt      = require('jsonwebtoken');
const axios    = require('axios');
const NodeCache = require('node-cache');

// ── Token / response caches ───────────────────────────────────
const tokenCache    = new NodeCache({ stdTTL: 3300 });   // 55 min — Google access tokens
const responseCache = new NodeCache({ stdTTL: 900 });    // 15 min — API responses

// ── Google service-account auth ───────────────────────────────

async function getGoogleAccessToken(scopes) {
  const cacheKey = `goog_token_${scopes.sort().join('|')}`;
  const cached   = tokenCache.get(cacheKey);
  if (cached) return cached;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');

  const sa  = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);

  const signedJwt = jwt.sign(
    { iss: sa.client_email, scope: scopes.join(' '), aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now },
    sa.private_key,
    { algorithm: 'RS256' }
  );

  const res = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedJwt }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  const token = res.data.access_token;
  tokenCache.set(cacheKey, token, 3300);
  return token;
}

// ── Play Console (Android Publisher API) ──────────────────────

async function getPlayConsoleData() {
  const CACHE_KEY = 'ext_play_console';
  const cached    = responseCache.get(CACHE_KEY);
  if (cached) return cached;

  const packageName = process.env.PLAY_STORE_PACKAGE_NAME;
  if (!packageName || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return { configured: false };
  }

  try {
    const token = await getGoogleAccessToken(['https://www.googleapis.com/auth/androidpublisher']);

    // Fetch up to 100 most recent reviews
    const reviewsRes = await axios.get(
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/reviews`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params:  { maxResults: 100 },
      }
    );

    const raw     = reviewsRes.data.reviews ?? [];
    const reviews = raw.map(r => {
      const uc = r.comments?.[0]?.userComment ?? {};
      return {
        authorName: r.authorName,
        rating:     uc.starRating ?? 0,
        text:       uc.text ?? '',
        date:       uc.lastModified?.seconds
          ? new Date(parseInt(uc.lastModified.seconds) * 1000).toISOString()
          : null,
        thumbsUp:   uc.thumbsUpCount ?? 0,
        replyText:  r.comments?.[1]?.developerComment?.text ?? null,
      };
    }).sort((a, b) => new Date(b.date ?? 0) - new Date(a.date ?? 0));

    // Aggregate
    const starCounts = [0, 0, 0, 0, 0, 0]; // index 0 unused; 1–5
    for (const rv of reviews) starCounts[rv.rating] = (starCounts[rv.rating] || 0) + 1;
    const totalRatings = reviews.length;
    const sumStars     = reviews.reduce((s, r) => s + r.rating, 0);
    const avgRating    = totalRatings > 0 ? Math.round((sumStars / totalRatings) * 10) / 10 : 0;

    const result = {
      configured: true,
      packageName,
      avgRating,
      totalRatings,
      starDistribution: [5, 4, 3, 2, 1].map(star => ({
        star,
        count: starCounts[star] ?? 0,
        pct:   totalRatings > 0 ? Math.round(((starCounts[star] ?? 0) / totalRatings) * 100) : 0,
      })),
      recentReviews: reviews.slice(0, 8),
    };

    responseCache.set(CACHE_KEY, result, 3600); // cache 1 hour (reviews rarely change fast)
    return result;

  } catch (err) {
    console.error('[External] Play Console error:', err.response?.data ?? err.message);
    return { configured: true, error: 'API error — check service account permissions (needs androidpublisher scope)' };
  }
}

// ── Firebase GA4 Data API ─────────────────────────────────────

async function getGA4Analytics(days = 30) {
  const CACHE_KEY = `ext_ga4_${days}`;
  const cached    = responseCache.get(CACHE_KEY);
  if (cached) return cached;

  const propertyId = process.env.GA4_PROPERTY_ID;
  if (!propertyId || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return { configured: false };
  }

  try {
    const token   = await getGoogleAccessToken(['https://www.googleapis.com/auth/analytics.readonly']);
    const headers = { Authorization: `Bearer ${token}` };
    const base    = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}`;
    const startDate = `${days}daysAgo`;

    const [summaryRes, dailyRes, screensRes, eventsRes] = await Promise.all([
      // Summary: aggregate metrics
      axios.post(`${base}:runReport`, {
        dateRanges: [{ startDate, endDate: 'today' }],
        metrics: [
          { name: 'activeUsers' }, { name: 'newUsers' },
          { name: 'sessions' },    { name: 'screenPageViews' },
          { name: 'averageSessionDuration' },
        ],
      }, { headers }),

      // Daily trend
      axios.post(`${base}:runReport`, {
        dateRanges: [{ startDate, endDate: 'today' }],
        dimensions: [{ name: 'date' }],
        metrics:    [{ name: 'activeUsers' }, { name: 'newUsers' }],
        orderBys:   [{ dimension: { dimensionName: 'date' } }],
      }, { headers }),

      // Top countries by active users
      axios.post(`${base}:runReport`, {
        dateRanges: [{ startDate, endDate: 'today' }],
        dimensions: [{ name: 'country' }],
        metrics:    [{ name: 'activeUsers' }],
        orderBys:   [{ metric: { metricName: 'activeUsers' }, desc: true }],
        limit:      12,
      }, { headers }),

      // Top events by count
      axios.post(`${base}:runReport`, {
        dateRanges: [{ startDate, endDate: 'today' }],
        dimensions: [{ name: 'eventName' }],
        metrics:    [{ name: 'eventCount' }],
        orderBys:   [{ metric: { metricName: 'eventCount' }, desc: true }],
        limit:      12,
      }, { headers }),
    ]);

    // Parse summary
    const sRow = summaryRes.data.rows?.[0]?.metricValues ?? [];
    const summary = {
      activeUsers:         parseInt(sRow[0]?.value ?? '0'),
      newUsers:            parseInt(sRow[1]?.value ?? '0'),
      sessions:            parseInt(sRow[2]?.value ?? '0'),
      screenPageViews:     parseInt(sRow[3]?.value ?? '0'),
      avgSessionDurationSec: parseFloat(sRow[4]?.value ?? '0'),
    };

    // Parse daily
    const dailyTrend = (dailyRes.data.rows ?? []).map(r => ({
      date:        r.dimensionValues[0].value,
      activeUsers: parseInt(r.metricValues[0].value),
      newUsers:    parseInt(r.metricValues[1].value),
    }));

    // Parse screens
    const topCountries = (screensRes.data.rows ?? []).map(r => ({
      country: r.dimensionValues[0].value || '(unknown)',
      users:   parseInt(r.metricValues[0].value),
    }));

    // Parse events
    const topEvents = (eventsRes.data.rows ?? [])
      .filter(r => !['user_engagement', 'session_start', 'first_open', 'os_update', 'app_update'].includes(r.dimensionValues[0].value))
      .slice(0, 10)
      .map(r => ({
        event: r.dimensionValues[0].value,
        count: parseInt(r.metricValues[0].value),
      }));

    const result = { configured: true, propertyId, days, summary, dailyTrend, topCountries, topEvents };
    responseCache.set(CACHE_KEY, result, 900);
    return result;

  } catch (err) {
    const detail = err.response?.data?.error?.message ?? err.response?.data ?? err.message;
    console.error('[External] GA4 error:', detail);
    return { configured: true, error: `GA4 API error: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` };
  }
}

// ── Meta Ads Insights API ─────────────────────────────────────

async function getMetaAdsData(days = 30) {
  const CACHE_KEY = `ext_meta_${days}`;
  const cached    = responseCache.get(CACHE_KEY);
  if (cached) return cached;

  const accessToken = process.env.META_ACCESS_TOKEN;
  const accountId   = process.env.META_AD_ACCOUNT_ID;

  if (!accessToken || !accountId) return { configured: false };

  try {
    const datePreset =
      days <= 7  ? 'last_7d'  :
      days <= 30 ? 'last_30d' : 'last_90d';

    // Campaign-level breakdown
    const campaignRes = await axios.get(
      `https://graph.facebook.com/v21.0/act_${accountId}/insights`,
      {
        params: {
          fields:       'campaign_name,spend,impressions,clicks,actions,cpm,ctr,cpp',
          level:        'campaign',
          date_preset:  datePreset,
          access_token: accessToken,
        },
      }
    );

    const campaigns = (campaignRes.data.data ?? []).map(c => {
      const installs = c.actions?.find(a =>
        ['mobile_app_install', 'app_install'].includes(a.action_type)
      )?.value ?? '0';
      const spend    = parseFloat(c.spend ?? '0');
      const inst     = parseInt(installs);
      return {
        name:        c.campaign_name,
        spend,
        impressions: parseInt(c.impressions ?? '0'),
        clicks:      parseInt(c.clicks ?? '0'),
        installs:    inst,
        cpi:         inst > 0 ? Math.round((spend / inst) * 100) / 100 : 0,
        ctr:         parseFloat(c.ctr ?? '0'),
        cpm:         parseFloat(c.cpm ?? '0'),
      };
    });

    // Account-level totals
    const totals = campaigns.reduce(
      (acc, c) => ({ spend: acc.spend + c.spend, impressions: acc.impressions + c.impressions, clicks: acc.clicks + c.clicks, installs: acc.installs + c.installs }),
      { spend: 0, impressions: 0, clicks: 0, installs: 0 }
    );
    totals.cpi = totals.installs > 0 ? Math.round((totals.spend / totals.installs) * 100) / 100 : 0;
    totals.ctr = totals.impressions > 0 ? Math.round((totals.clicks / totals.impressions) * 10000) / 100 : 0;

    const result = { configured: true, accountId, days, datePreset, totals, campaigns };
    responseCache.set(CACHE_KEY, result, 900);
    return result;

  } catch (err) {
    const fb = err.response?.data?.error;
    console.error('[External] Meta Ads error:', fb ?? err.message);
    const msg = fb?.message ?? 'API error';
    return { configured: true, error: `Meta API: ${msg}` };
  }
}

// ── Combined endpoint ─────────────────────────────────────────

async function getAllExternal(days = 30) {
  const [playConsole, ga4, metaAds] = await Promise.all([
    getPlayConsoleData(),
    getGA4Analytics(days),
    getMetaAdsData(days),
  ]);
  return { playConsole, ga4, metaAds };
}

module.exports = { getPlayConsoleData, getGA4Analytics, getMetaAdsData, getAllExternal };
