import { startBrowserSentry } from "@/lib/sentry";

/**
 * Browser Sentry (E-08). Disabled while `NEXT_PUBLIC_SENTRY_DSN` is unset: then the SDK is never
 * downloaded at all.
 *
 * The SDK is not imported here: this file runs before every page hydrates, so a static import put
 * ≈120 KB of compressed JavaScript in front of every page (T-087a). `startBrowserSentry` loads it
 * as its own chunk once the page has loaded, and keeps any error thrown before then for it.
 *
 * The two public variables are read literally (Next.js inlines them at build time) instead of via
 * `clientEnv` from `@/env`: that import put Zod (~50 kB gzip) into the JavaScript of every page.
 * They are still validated: `next.config.ts` imports `@/env`, which parses `clientEnv` on the server
 * at `next build` / `next start` / `next dev`, so an invalid value never ships (T-087).
 */
export const onRouterTransitionStart = startBrowserSentry({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN || undefined,
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV,
  load: async () => {
    const { init, captureException, captureRouterTransitionStart } = await import("@sentry/nextjs");
    return { init, captureException, captureRouterTransitionStart };
  },
  target: window,
});
