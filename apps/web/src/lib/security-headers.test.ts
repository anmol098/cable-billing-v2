import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, securityHeaders, sentryDsnParts } from "./security-headers";

const header = (headers: { key: string; value: string }[], key: string) =>
  headers.find((h) => h.key === key)?.value;

describe("securityHeaders", () => {
  it("enforces HSTS and frame-ancestors 'none', and reports the full CSP only", () => {
    const headers = securityHeaders({ isDev: false });
    expect(header(headers, "Strict-Transport-Security")).toBe(
      "max-age=63072000; includeSubDomains",
    );
    expect(header(headers, "Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(header(headers, "X-Frame-Options")).toBe("DENY");
    expect(header(headers, "X-Content-Type-Options")).toBe("nosniff");
    const reportOnly = header(headers, "Content-Security-Policy-Report-Only");
    expect(reportOnly).toContain("default-src 'self'");
    expect(reportOnly).toContain("frame-ancestors 'none'");
    expect(reportOnly).toContain("object-src 'none'");
  });

  it("allows 'unsafe-eval' only in development", () => {
    expect(contentSecurityPolicy({ isDev: true })).toContain("'unsafe-eval'");
    expect(contentSecurityPolicy({ isDev: false })).not.toContain("'unsafe-eval'");
  });

  it("sends CSP reports to Sentry and allows its ingest host when a DSN is set", () => {
    const csp = contentSecurityPolicy({
      isDev: false,
      sentryDsn: "https://abc123@o42.ingest.sentry.io/7",
    });
    expect(csp).toContain("connect-src 'self' https://o42.ingest.sentry.io");
    expect(csp).toContain(
      "report-uri https://o42.ingest.sentry.io/api/7/security/?sentry_key=abc123",
    );
  });

  it("lets the sign-up page load Cloudflare Turnstile (script + challenge frame) and nothing else", () => {
    const csp = contentSecurityPolicy({ isDev: false });
    expect(csp).toContain("script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com");
    expect(csp).toContain("frame-src https://challenges.cloudflare.com");
    // Razorpay Checkout on Settings → App subscription (T-085).
    expect(csp).toContain("https://challenges.cloudflare.com https://checkout.razorpay.com;");
    expect(csp).toContain("frame-src https://challenges.cloudflare.com https://api.razorpay.com;");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("has no report-uri without a DSN", () => {
    expect(contentSecurityPolicy({ isDev: false })).not.toContain("report-uri");
  });
});

describe("sentryDsnParts", () => {
  it("ignores missing or malformed DSNs", () => {
    expect(sentryDsnParts(undefined)).toBeUndefined();
    expect(sentryDsnParts("not a url")).toBeUndefined();
    expect(sentryDsnParts("https://o42.ingest.sentry.io/7")).toBeUndefined();
  });
});
