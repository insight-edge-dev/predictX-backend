/**
 * dbWriteQueue.js — Priority write queue for Supabase with circuit breaker.
 *
 * Three priority lanes processed in strict order:
 *   high   — live score updates, scorecards (blocks the app if delayed)
 *   normal — fixtures, standings, teams, leagues  (background, user-visible)
 *   low    — predictions, highlights, player stats (best-effort enrichment)
 *
 * Circuit breaker: if 3 consecutive writes fail (Supabase unhealthy),
 * all further writes are rejected for 2 minutes — giving PostgREST time
 * to recover instead of flooding it with retries.
 *
 * Usage inside highlightlyStorageService:
 *   return dbWriteQueue.enqueue(async () => { ... }, 'high');
 *
 * Fire-and-forget (serving path):
 *   void storeFixtures(data);   // queued but not awaited — response is immediate
 */

const WRITE_SPACING_MS           = 200;  // gap between consecutive Supabase calls
const CIRCUIT_FAIL_THRESHOLD     = 3;
const CIRCUIT_COOLDOWN_MS        = 10 * 60_000; // 10 min — NANO Postgres needs ~5-10 min to recover from OOM

class PriorityWriteQueue {
  constructor() {
    this._high    = [];
    this._normal  = [];
    this._low     = [];
    this._running = false;

    // Circuit breaker state
    this._failures    = 0;
    this._pausedUntil = 0;
  }

  /**
   * Enqueue a write. Returns a Promise that resolves with fn's return value.
   * @param {() => Promise<any>} fn  — async function that performs the Supabase write
   * @param {'high'|'normal'|'low'} priority
   */
  enqueue(fn, priority = 'normal') {
    return new Promise((resolve, reject) => {
      (this._high.length === 0 && priority !== 'high' ? null : null); // no-op
      const lane = priority === 'high' ? this._high
                 : priority === 'low'  ? this._low
                 :                       this._normal;
      lane.push({ fn, resolve, reject });
      if (!this._running) this._drain();
    });
  }

  get depth() {
    return this._high.length + this._normal.length + this._low.length;
  }

  _next() {
    return this._high.shift() ?? this._normal.shift() ?? this._low.shift();
  }

  async _drain() {
    this._running = true;
    let item;
    while ((item = this._next())) {
      // Circuit breaker open — reject immediately instead of hammering Supabase
      if (Date.now() < this._pausedUntil) {
        const waitSec = Math.ceil((this._pausedUntil - Date.now()) / 1_000);
        console.warn(`[DB Queue] circuit open — write rejected (resumes in ${waitSec}s)`);
        item.reject(new Error(`Supabase circuit open, resumes in ${waitSec}s`));
        continue;
      }

      try {
        item.resolve(await item.fn());
        this._failures = 0; // reset streak on any success
      } catch (e) {
        this._failures++;
        if (this._failures >= CIRCUIT_FAIL_THRESHOLD) {
          this._pausedUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
          console.warn(`[DB Queue] ${CIRCUIT_FAIL_THRESHOLD} consecutive failures — circuit open for 2 min`);
        }
        item.reject(e);
      }

      if (this._next()) {
        await new Promise(r => setTimeout(r, WRITE_SPACING_MS));
      }
    }
    this._running = false;
  }

  /** True if the circuit is currently open (Supabase recovering). */
  get isCircuitOpen() { return Date.now() < this._pausedUntil; }
}

const dbWriteQueue = new PriorityWriteQueue();

module.exports = { dbWriteQueue };
