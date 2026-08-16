/**
 * apiRateLimiter.js — Token bucket rate limiter for Highlightly API calls.
 *
 * Configured for Highlightly: 30 requests/minute sustained, burst of 5.
 * Every call to highlightlyService._get() acquires a token before firing,
 * so even when multiple sync jobs overlap at boot, outbound requests never
 * exceed the quota — preventing 429s that would black out all data fetching
 * for 5 minutes (the circuit-breaker cooldown in highlightlyService.js).
 *
 * Token bucket algorithm:
 *   - Bucket holds up to `capacity` tokens.
 *   - Tokens refill at `refillPerSecond` rate (capped at capacity).
 *   - Each API call consumes 1 token.
 *   - If no token is available, the caller waits until one is refilled.
 */

class TokenBucket {
  constructor(capacity, refillPerSecond) {
    this._capacity    = capacity;
    this._tokens      = capacity;          // start full — allows immediate burst
    this._refillPerMs = refillPerSecond / 1000;
    this._lastRefill  = Date.now();
    this._waiters     = [];                // pending acquire() resolvers, FIFO

    // Tick every 250 ms so waiters are woken promptly without busy-looping.
    this._timer = setInterval(() => this._tick(), 250);
    if (this._timer.unref) this._timer.unref(); // don't keep the process alive
  }

  _tick() {
    const now     = Date.now();
    const elapsed = now - this._lastRefill;
    this._lastRefill = now;
    this._tokens  = Math.min(this._capacity, this._tokens + elapsed * this._refillPerMs);

    while (this._waiters.length > 0 && this._tokens >= 1) {
      this._tokens -= 1;
      this._waiters.shift()(); // wake the oldest waiter
    }
  }

  acquire() {
    this._tick(); // try an immediate refill first
    if (this._tokens >= 1) {
      this._tokens -= 1;
      return Promise.resolve();
    }
    // No token available — enqueue and wait
    return new Promise(resolve => this._waiters.push(resolve));
  }

  get queueDepth() { return this._waiters.length; }

  /**
   * Adaptive update from Highlightly response headers.
   * If the API tells us we're near the limit, drain the bucket so future
   * callers pause until the quota window resets.
   *
   * Header names vary by API gateway — we try the most common variants.
   * @param {object} headers — axios response headers object
   */
  updateFromHeaders(headers) {
    const remaining = parseInt(
      headers["x-ratelimit-requests-remaining"] ??
      headers["x-ratelimit-remaining"]          ??
      headers["ratelimit-remaining"]            ??
      "",
      10,
    );
    const resetEpoch = parseInt(
      headers["x-ratelimit-reset"]   ??
      headers["ratelimit-reset"]     ??
      "",
      10,
    );

    if (isNaN(remaining)) return; // headers not present — do nothing

    if (remaining <= 5 && !isNaN(resetEpoch)) {
      // Near the limit — drain bucket so all pending waiters pause
      const resetMs = resetEpoch > 1_000_000_000_000
        ? resetEpoch                    // already milliseconds
        : resetEpoch * 1_000;           // seconds → milliseconds
      const pauseMs = Math.max(0, resetMs - Date.now());
      if (pauseMs > 0 && pauseMs < 120_000) {
        this._tokens = 0;
        console.warn(`[Rate Limiter] ${remaining} requests remaining — pausing ${Math.round(pauseMs / 1000)}s until quota resets`);
      }
    }
  }

  destroy() { clearInterval(this._timer); }
}

// 30 req/min = 0.5/s, burst of 5
const highlightlyLimiter = new TokenBucket(5, 0.5);

module.exports = { highlightlyLimiter };
