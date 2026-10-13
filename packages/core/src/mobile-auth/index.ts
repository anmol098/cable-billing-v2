/** Mobile authentication (T-028): lineman sign-in, tokens, devices, app config. See ./mobile-auth.ts. */
export {
  DEVICE_CODE_ALPHABET,
  DEVICE_CODE_LENGTH,
} from "./device-code";
export {
  type CreateMobileAuthServiceOptions,
  createMobileAuthService,
  MOBILE_AUTH_RATE_LIMITS,
  type MobileAppConfig,
  type MobileAuthentication,
  type MobileAuthFailure,
  type MobileAuthFailureCode,
  type MobileAuthResult,
  type MobileAuthService,
  type MobileDeviceInfo,
  type MobileLoginInput,
  type MobileLoginResult,
  type MobileOperatorInfo,
  type MobileRequestMeta,
  type MobileTokens,
} from "./mobile-auth";
export {
  type RevokeDeviceCommand,
  RevokeDeviceInput,
  type RevokeDeviceResult,
  revokeDevice,
  revokeMobileRefreshTokens,
} from "./revoke";
export {
  ACCESS_TOKEN_TTL_SECONDS,
  type AccessTokenClaims,
  REFRESH_REUSE_GRACE_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from "./tokens";
export {
  APP_VERSION_CODE_HEADER,
  DEFAULT_MIN_APP_VERSION_CODE,
  parseAppVersionCode,
} from "./version-gate";
