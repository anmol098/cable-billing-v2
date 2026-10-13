/**
 * Rate limiting for sign-in, password reset and two-factor checks (PLAN §9.4, E-07).
 *
 * Fixed-window counters: every attempt counts (successful or not), and the counter and its expiry
 * are set in one atomic step, so parallel requests can't slip past the limit.
 *
 * - Production: Upstash Redis over its REST API (`createUpstashRateLimiter`), shared by every
 *   function instance. Required in production by the env module (T-011).
 * - Local, CI, tests and previews without Upstash: `createMemoryRateLimiter`, one counter set per
 *   process (good enough there; not a real limit on a multi-instance deployment).
 *
 * Keys never contain a login or email in clear: callers pass {@link rateLimitKey}, which hashes
 * the identifying part.
 */
import { createHash } from "node:crypto";

export interface RateLimitRule {
  /** Attempts allowed per window. */
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  /** Seconds until the window resets (0 when allowed). */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  readonly kind: "memory" | "upstash";
  /** Counts one attempt for `key` and says whether it is within `rule`. */
  hit(key: string, rule: RateLimitRule): Promise<RateLimitResult>;
}

/**
 * The limits (tunable). Per-IP limits are generous because many Indian mobile users share an IP
 * (carrier-grade NAT); the per-account limits are what stop password guessing.
 */
export const AUTH_RATE_LIMITS = Object.freeze({
  /** Sign-in attempts per login name / email (any outcome). The ×N of "wrong password ×N". */
  signInPerAccount: { limit: 10, windowSeconds: 15 * 60 },
  signInPerIp: { limit: 100, windowSeconds: 15 * 60 },
  /** Reset emails asked for one address. */
  resetRequestPerEmail: { limit: 3, windowSeconds: 60 * 60 },
  resetRequestPerIp: { limit: 20, windowSeconds: 60 * 60 },
  /** Setting a new password with a reset link. */
  resetPerIp: { limit: 20, windowSeconds: 60 * 60 },
  /** Two-factor code checks and enrolment (Better Auth also locks a challenge after 5 tries). */
  twoFactorPerIp: { limit: 30, windowSeconds: 15 * 60 },
} satisfies Record<string, RateLimitRule>);

/** A key like `signin:account:<sha256(value)>`; `value` (a login, an email, an IP) is hashed. */
export function rateLimitKey(scope: string, value: string): string {
  return `${scope}:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

/** In-process fixed windows. `now` is injectable for tests. */
export function createMemoryRateLimiter(
  options: { now?: () => number; maxKeys?: number } = {},
): RateLimiter {
  const now = options.now ?? (() => Date.now());
  const maxKeys = options.maxKeys ?? 50_000;
  const windows = new Map<string, { count: number; resetAt: number }>();

  const prune = (at: number) => {
    for (const [key, window] of windows) if (window.resetAt <= at) windows.delete(key);
  };

  return {
    kind: "memory",
    async hit(key, rule) {
      const at = now();
      let window = windows.get(key);
      if (!window || window.resetAt <= at) {
        if (windows.size >= maxKeys) prune(at);
        window = { count: 0, resetAt: at + rule.windowSeconds * 1000 };
        windows.set(key, window);
      }
      window.count += 1;
      const allowed = window.count <= rule.limit;
      return {
        allowed,
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((window.resetAt - at) / 1000)),
      };
    },
  };
}

/**
 * INCR + PEXPIRE on the first hit, in one script (atomic in Redis). Returns the count and the
 * milliseconds left in the window.
 */
export const UPSTASH_FIXED_WINDOW_SCRIPT = [
  "local count = redis.call('INCR', KEYS[1])",
  "if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end",
  "local ttl = redis.call('PTTL', KEYS[1])",
  "if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) ttl = tonumber(ARGV[1]) end",
  "return {count, ttl}",
].join("\n");

export interface UpstashRateLimiterOptions {
  /** `UPSTASH_REDIS_REST_URL`. */
  readonly url: string;
  /** `UPSTASH_REDIS_REST_TOKEN`. */
  readonly token: string;
  /** Key prefix (default `cb:rl:`). */
  readonly prefix?: string;
  /** Per-call timeout (default 2000 ms). */
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/**
 * Upstash Redis REST (`POST <url>` with a JSON command array). No SDK: one `EVAL` per attempt.
 * Network or Redis failures reject; the caller decides (the auth hooks fail open and log, so an
 * Upstash outage can't lock everyone out).
 */
export function createUpstashRateLimiter(options: UpstashRateLimiterOptions): RateLimiter {
  const doFetch = options.fetch ?? fetch;
  const prefix = options.prefix ?? "cb:rl:";
  const timeoutMs = options.timeoutMs ?? 2000;
  const url = options.url.replace(/\/+$/, "");
  return {
    kind: "upstash",
    async hit(key, rule) {
      const windowMs = rule.windowSeconds * 1000;
      const response = await doFetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([
          "EVAL",
          UPSTASH_FIXED_WINDOW_SCRIPT,
          "1",
          `${prefix}${key}`,
          String(windowMs),
        ]),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`Upstash rate limit call failed (HTTP ${response.status})`);
      const body = (await response.json()) as { result?: unknown; error?: unknown };
      const result = body.result;
      if (
        !Array.isArray(result) ||
        typeof result[0] !== "number" ||
        typeof result[1] !== "number"
      ) {
        throw new Error("Upstash rate limit call returned an unexpected result");
      }
      const [count, ttlMs] = result as [number, number];
      const allowed = count <= rule.limit;
      return {
        allowed,
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(ttlMs / 1000)),
      };
    },
  };
}
