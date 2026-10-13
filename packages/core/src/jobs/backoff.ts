/**
 * Retry delay after a failed attempt: exponential backoff with "equal jitter".
 *
 * `cap = min(maxMs, baseMs × 2^(attempt − 1))`, delay = `cap/2 + random() × cap/2`. So the delay
 * is never below half the exponential step (no hot retry loops) and workers that failed together
 * don't retry together. Pass `random` to make it deterministic in tests.
 *
 * Defaults: 30 s, 60 s, 2 min, 4 min … capped at 1 h (before jitter). With 5 attempts a failing
 * job is given up on after roughly 4–8 minutes of waiting, well inside one day.
 */
export interface BackoffOptions {
  readonly baseMs?: number;
  readonly maxMs?: number;
  /** A number in [0, 1). Default `Math.random`. */
  readonly random?: () => number;
}

export const DEFAULT_BACKOFF_BASE_MS = 30_000;
export const DEFAULT_BACKOFF_MAX_MS = 60 * 60_000;

/** Delay in ms before attempt `attempt + 1`, after attempt number `attempt` (1-based) failed. */
export function backoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const max = options.maxMs ?? DEFAULT_BACKOFF_MAX_MS;
  const random = options.random ?? Math.random;
  const n = Math.max(1, Math.floor(attempt));
  // 2^30 × 30 s overflows nothing in doubles, but cap the exponent anyway.
  const cap = Math.min(max, base * 2 ** Math.min(n - 1, 30));
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(cap / 2 + (r * cap) / 2);
}
