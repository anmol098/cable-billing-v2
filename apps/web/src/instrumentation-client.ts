import * as Sentry from "@sentry/nextjs";
import { sentrySharedOptions } from "@/lib/sentry";

/**
 * Browser Sentry (E-08). Disabled while `NEXT_PUBLIC_SENTRY_DSN` is unset.
 *
 * The two public variables are read literally (Next.js inlines them at build time) instead of via
 * `clientEnv` from `@/env`: that import put Zod (~50 kB gzip) into the JavaScript of every page.
 * They are still validated: `next.config.ts` imports `@/env`, which parses `clientEnv` on the server
 * at `next build` / `next start` / `next dev`, so an invalid value never ships (T-087).
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN || undefined;

Sentry.init({
  ...sentrySharedOptions,
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
