import * as Sentry from "@sentry/nextjs";
import { clientEnv } from "@/env";
import { sentrySharedOptions } from "@/lib/sentry";

/** Browser Sentry (E-08). Disabled while `NEXT_PUBLIC_SENTRY_DSN` is unset. */
const dsn = clientEnv.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  ...sentrySharedOptions,
  dsn,
  enabled: Boolean(dsn),
  environment: clientEnv.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
