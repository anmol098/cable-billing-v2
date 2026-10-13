import * as Sentry from "@sentry/nextjs";
import { sentrySharedOptions } from "@/lib/sentry";

/**
 * Runs once when a server (Node.js or edge) instance boots. Importing `@/env` here validates the
 * server environment before the first request (fail fast); on Vercel it also checks that every
 * variable the deployment needs is present (T-011, skipped while `next build` prerenders). Sentry
 * (E-08) is initialised but stays disabled while `SENTRY_DSN` is unset.
 */
export async function register(): Promise<void> {
  const { assertDeploymentEnv, clientEnv, isNextBuildPhase, serverEnv } = await import("@/env");
  const dsn = serverEnv.SENTRY_DSN;
  Sentry.init({
    ...sentrySharedOptions,
    dsn,
    enabled: Boolean(dsn),
    environment: serverEnv.SENTRY_ENVIRONMENT ?? serverEnv.VERCEL_ENV ?? serverEnv.NODE_ENV,
    release: serverEnv.VERCEL_GIT_COMMIT_SHA,
  });
  if (isNextBuildPhase()) return;
  // After Sentry.init, so a deployment that is missing variables also shows up in Sentry.
  try {
    assertDeploymentEnv({ ...serverEnv, ...clientEnv });
  } catch (error) {
    Sentry.captureException(error);
    await Sentry.flush(2000);
    throw error;
  }
}

export const onRequestError = Sentry.captureRequestError;
