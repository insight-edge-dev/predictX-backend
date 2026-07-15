/**
 * lightTipService.js — persistence wrapper for lightweight match predictions.
 *
 * Extracted from tipsController so service-layer callers (accuracyService, etc.)
 * don't need to import a controller. Logic is identical to the original.
 *
 * Cache strategy:
 *   1. NodeCache (PRED_TTL_MEM = 24h) — fastest, dies on restart
 *   2. Supabase series table (PRED_TTL_DB = 1 year) — survives restarts
 *   3. Generate fresh via tipsService (IPL) or genericTipsService (other leagues)
 */

const tipsService  = require("./tipsService");
const genericTips  = require("./genericTipsService");
const db           = require("./dbService");
const { getCache, setCache, TTL } = require("./cacheService");

const PRED_TTL_DB  = 365 * 24 * 60 * 60_000; // 1 year — predictions are static pre-match data
const PRED_TTL_MEM = TTL.DAILY;               // 24 h in memory

/**
 * Returns a cached or freshly-generated lightweight tip for `match`.
 *
 * ctx shape:
 *   { isIPL: true }                                    — uses 7-factor IPL model
 *   { isIPL: false, table, completed, slug }           — uses generic model
 */
async function getPersistentLightTip(match, ctx) {
  const memKey = `tips:light:${match.id}`;
  const dbKey  = `pred:light:${match.id}`;

  const mem = getCache(memKey);
  if (mem) return mem;

  const stored = await db.getCachedData(dbKey, PRED_TTL_DB);
  if (stored) {
    setCache(memKey, stored, PRED_TTL_MEM);
    return stored;
  }

  const tip = ctx.isIPL
    ? await tipsService.getLightweightTip(match)
    : await genericTips.getLightweightTip(match, ctx.table, ctx.completed, ctx.slug);

  if (tip) {
    setCache(memKey, tip, PRED_TTL_MEM);
    void db.setCachedData(dbKey, tip);
    console.log(`[Tips] stored prediction for match ${match.id}`);
  }
  return tip;
}

module.exports = { getPersistentLightTip };
