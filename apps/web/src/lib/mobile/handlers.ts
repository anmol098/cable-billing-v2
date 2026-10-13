/**
 * The four T-028 endpoints as route handlers (the `route.ts` files only bind them to
 * `getMobileDeps`, so tests can run them with a stub service).
 *
 * | Route | Contract | Auth | Version gate |
 * |---|---|---|---|
 * | `POST /api/mobile/v1/auth/login` | `login` | none | yes |
 * | `POST /api/mobile/v1/auth/refresh` | `refreshTokens` | none (refresh token in the body) | yes |
 * | `POST /api/mobile/v1/auth/logout` | `logout` | none (refresh token in the body) | **no** |
 * | `GET /api/mobile/v1/app/config` | `getAppConfig` | bearer | **no** |
 */
import { ENDPOINTS, LoginRequest, LogoutRequest, RefreshRequest } from "@cb/contracts";
import { type MobileDeps, mobileRoute, readJsonBody, withMobileAuth } from "./http";
import { appConfigWire, loginWire, tokenPairWire } from "./wire";

export function loginHandler(getDeps: () => MobileDeps) {
  return mobileRoute(ENDPOINTS.login, getDeps, async (scope) => {
    const body = await readJsonBody(scope, LoginRequest);
    if (!body.ok) return body.response;
    const { login, password, device } = body.value;
    const result = await scope.deps.auth.login(
      {
        login,
        password,
        device: {
          installId: device.install_id,
          model: device.model,
          os: device.os,
          appVersion: device.app_version,
          appVersionCode: device.app_version_code,
        },
      },
      scope.meta,
    );
    if (!result.ok) return scope.reply.authFailure(result.error);
    return scope.reply.ok(loginWire(result.value));
  });
}

export function refreshHandler(getDeps: () => MobileDeps) {
  return mobileRoute(ENDPOINTS.refreshTokens, getDeps, async (scope) => {
    const body = await readJsonBody(scope, RefreshRequest);
    if (!body.ok) return body.response;
    const result = await scope.deps.auth.refresh(
      { refreshToken: body.value.refresh_token, installId: body.value.install_id },
      scope.meta,
    );
    if (!result.ok) return scope.reply.authFailure(result.error);
    return scope.reply.ok({ tokens: tokenPairWire(result.value.tokens) });
  });
}

export function logoutHandler(getDeps: () => MobileDeps) {
  return mobileRoute(ENDPOINTS.logout, getDeps, async (scope) => {
    const body = await readJsonBody(scope, LogoutRequest);
    if (!body.ok) return body.response;
    const result = await scope.deps.auth.logout(
      { refreshToken: body.value.refresh_token },
      scope.meta,
    );
    if (!result.ok) return scope.reply.authFailure(result.error);
    return scope.reply.ok({});
  });
}

export function appConfigHandler(getDeps: () => MobileDeps) {
  return withMobileAuth(ENDPOINTS.getAppConfig, getDeps, async ({ ctx, deps, reply }) =>
    reply.ok(appConfigWire(await deps.auth.appConfig(ctx))),
  );
}
