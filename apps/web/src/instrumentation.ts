import * as Sentry from "@sentry/nextjs";
import { sentrySharedOptions } from "@/lib/sentry";

/**
 * Runs once when a server (Node.js or edge) instance boots. Importing `@/env` here validates the
 * server environment before the first request (fail fast). Sentry (E-08) is initialised but stays
 * disabled while `SENTRY_DSN` is unset.
 */
export async function register(): Promise<void> {
  const { serverEnv } = await import("@/env");
  const dsn = serverEnv.SENTRY_DSN;
  Sentry.init({
    ...sentrySharedOptions,
    dsn,
    enabled: Boolean(dsn),
    environment: serverEnv.SENTRY_ENVIRONMENT ?? serverEnv.VERCEL_ENV ?? serverEnv.NODE_ENV,
    release: serverEnv.VERCEL_GIT_COMMIT_SHA,
  });
}

export const onRequestError = Sentry.captureRequestError;
