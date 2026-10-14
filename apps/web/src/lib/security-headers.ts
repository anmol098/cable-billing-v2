/**
 * HTTP security headers for every response (applied in `next.config.ts`).
 *
 * The full Content-Security-Policy starts as **report-only** so it can be tightened from real
 * reports without breaking pages. Two things are enforced from day one: `frame-ancestors 'none'`
 * (browsers ignore it in a report-only policy, so it gets its own enforced CSP header, plus
 * `X-Frame-Options` for old browsers) and HSTS.
 */

export type HeaderEntry = { key: string; value: string };

export type SecurityHeaderOptions = {
  /** `next dev` needs `'unsafe-eval'` for React Refresh. */
  isDev: boolean;
  /** Browser Sentry DSN, if any: its host is allowed in `connect-src` and receives CSP reports. */
  sentryDsn?: string | undefined;
};

/** Two years, the value HSTS preload lists expect. `preload` is not set until the domain is decided (D-21). */
export const HSTS_VALUE = "max-age=63072000; includeSubDomains";

type SentryDsnParts = { origin: string; reportUri: string };

/** `https://<key>@<host>/<project>` → Sentry's CSP report endpoint for that project. */
export function sentryDsnParts(dsn: string | undefined): SentryDsnParts | undefined {
  if (!dsn) return undefined;
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return undefined;
  }
  const projectId = url.pathname.split("/").filter(Boolean).pop();
  if (!url.username || !projectId) return undefined;
  const origin = `${url.protocol}//${url.host}`;
  return {
    origin,
    reportUri: `${origin}/api/${projectId}/security/?sentry_key=${url.username}`,
  };
}

/** Cloudflare Turnstile (sign-up bot check, T-027): its script and its challenge iframe. */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** Razorpay Checkout (T-085, Settings → App subscription): its script and its payment iframe. */
export const RAZORPAY_CHECKOUT_ORIGIN = "https://checkout.razorpay.com";
export const RAZORPAY_API_ORIGIN = "https://api.razorpay.com";

export function contentSecurityPolicy({ isDev, sentryDsn }: SecurityHeaderOptions): string {
  const sentry = sentryDsnParts(sentryDsn);
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // Next.js inlines bootstrap scripts; nonces can replace 'unsafe-inline' once pages need it.
    "script-src": [
      "'self'",
      "'unsafe-inline'",
      ...(isDev ? ["'unsafe-eval'"] : []),
      TURNSTILE_ORIGIN,
      RAZORPAY_CHECKOUT_ORIGIN,
    ],
    "frame-src": [TURNSTILE_ORIGIN, RAZORPAY_API_ORIGIN],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'"],
    "connect-src": ["'self'", ...(sentry ? [sentry.origin] : [])],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  if (sentry) directives["report-uri"] = [sentry.reportUri];
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

export function securityHeaders(options: SecurityHeaderOptions): HeaderEntry[] {
  return [
    { key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy(options) },
    { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Strict-Transport-Security", value: HSTS_VALUE },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  ];
}
