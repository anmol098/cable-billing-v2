/**
 * `@cb/core` mobile auth results (camelCase, Dates) → the contract's wire shapes (snake_case, ISO
 * instants). The route helpers validate the result against the contract before sending it.
 */

import type { AppConfigResponse, LoginResponse, RefreshResponse } from "@cb/contracts";
import type {
  MobileAppConfig,
  MobileLoginResult,
  MobileOperatorInfo,
  MobileTokens,
} from "@cb/core";

type Wire<T> = Omit<T, "server_time">;

export function tokenPairWire(tokens: MobileTokens): Wire<RefreshResponse>["tokens"] {
  return {
    token_type: "Bearer",
    access_token: tokens.accessToken,
    access_token_expires_at: tokens.accessTokenExpiresAt.toISOString(),
    refresh_token: tokens.refreshToken,
    refresh_token_expires_at: tokens.refreshTokenExpiresAt.toISOString(),
  };
}

export function operatorWire(operator: MobileOperatorInfo): Wire<LoginResponse>["operator"] {
  return {
    id: operator.id,
    name: operator.name,
    office_phone: operator.officePhone,
    receipt_footer: operator.receiptFooter,
  };
}

export function loginWire(result: MobileLoginResult): Wire<LoginResponse> {
  return {
    tokens: tokenPairWire(result.tokens),
    user: {
      id: result.user.id,
      name: result.user.name,
      login: result.user.login,
      language: result.user.language,
    },
    operator: operatorWire(result.operator),
    device: { id: result.device.id, device_code: result.device.deviceCode },
  };
}

export function appConfigWire(config: MobileAppConfig): Wire<AppConfigResponse> {
  return {
    min_app_version_code: config.minAppVersionCode,
    operator: operatorWire(config.operator),
    tenant_mode: config.tenantMode,
    features: { ...config.features },
  };
}
