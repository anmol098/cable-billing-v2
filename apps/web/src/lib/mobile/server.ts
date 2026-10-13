/**
 * Server singletons for the mobile API (T-028): the mobile auth service over the app's shared
 * service runtime (database, logger, clock) and rate limiter (both from `@/lib/auth/server`, so web
 * and phone sign-in attempts share their limits). Built on first use, never at import, so
 * `next build` works without any environment (T-011). Server-only.
 */
import { createMobileAuthService, type MobileAuthService } from "@cb/core";
import { requireServerEnv } from "@/env";
import { getRateLimiter, getServerRuntime } from "@/lib/auth/server";
import { MIN_APP_VERSION_CODE, MOBILE_FEATURES } from "./config";
import type { MobileDeps } from "./http";

const KEY = Symbol.for("@cb/web/mobile-auth");
const holder = globalThis as unknown as Record<symbol, MobileAuthService | undefined>;

function mobileAuth(): MobileAuthService {
  let service = holder[KEY];
  if (!service) {
    const { BETTER_AUTH_SECRET } = requireServerEnv("BETTER_AUTH_SECRET");
    service = createMobileAuthService({
      runtime: getServerRuntime(),
      secret: BETTER_AUTH_SECRET,
      rateLimiter: getRateLimiter(),
      minAppVersionCode: MIN_APP_VERSION_CODE,
      features: MOBILE_FEATURES,
    });
    holder[KEY] = service;
  }
  return service;
}

/** What every mobile route needs (pass `getMobileDeps` to the route factories in `./http`). */
export function getMobileDeps(): MobileDeps {
  const runtime = getServerRuntime();
  return { auth: mobileAuth(), runtime, logger: runtime.logger };
}
