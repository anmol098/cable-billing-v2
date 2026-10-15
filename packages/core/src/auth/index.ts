/** Web authentication (T-026). See ./auth.ts for the overview. */
export { platformAuthAdapter } from "./adapter";
export {
  ADMIN_SETUP_LINK_TTL_SECONDS,
  ADMIN_SETUP_PATH,
  AdminSetupIssueError,
  type AdminSetupIssueErrorCode,
  type AdminSetupIssuer,
  type AdminSetupKey,
  type AdminSetupService,
  adminSetupBaseUrlProblem,
  adminSetupUrl,
  type CreateAdminSetupServiceOptions,
  createAdminSetupService,
  createPlatformAdmin,
  type IssuedAdminSetupLink,
  reissueAdminSetupLink,
} from "./admin-setup";
export {
  AUTH_AUDIT_ACTIONS,
  type AuthAuditAction,
  type AuthAuditSubject,
  recordAuthEvent,
} from "./audit-events";
export {
  AUTH_BASE_PATH,
  AUTH_COOKIE_PREFIX,
  type AuthFailure,
  type AuthFailureCode,
  type AuthResult,
  type AuthService,
  type CreateAuthServiceOptions,
  createAuthService,
  type PasswordResetEmail,
  type PasswordResetInvite,
  type SignInOutcome,
  TOTP_OPTIONS,
  TWO_FACTOR_LOCKOUT,
  type TwoFactorEnrolment,
  type WebSession,
} from "./auth";
export {
  type CaptureTransport,
  createCaptureTransport,
  createResendTransport,
  // Aliased: T-043's job alerts export their own EmailMessage / EmailTransport /
  // ResendTransportOptions from @cb/core. Follow-up: merge both into one shared email module.
  type EmailMessage as AuthEmailMessage,
  type EmailTransport as AuthEmailTransport,
  type ResendTransportOptions as AuthResendTransportOptions,
} from "./email";
export {
  ARGON2_PARAMETERS,
  hashPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  verifyPassword,
} from "./password";
export {
  isWebRole,
  LOGIN_PATH,
  platformAdminSessionExpiry,
  postSignInPath,
  ROLE_HOME,
  SESSION_POLICY,
  type SignInBlockReason,
  type SignInSubject,
  safeNextPath,
  TWO_FACTOR_SETUP_PATH,
  TWO_FACTOR_VERIFY_PATH,
  WEB_SIGN_IN_ROLES,
  type WebRole,
  webSignInBlock,
} from "./policy";
export {
  AUTH_RATE_LIMITS,
  createMemoryRateLimiter,
  createUpstashRateLimiter,
  type RateLimiter,
  type RateLimitResult,
  type RateLimitRule,
  rateLimitKey,
  UPSTASH_FIXED_WINDOW_SCRIPT,
  type UpstashRateLimiterOptions,
} from "./rate-limit";
export { CLIENT_IP_HEADERS, clientInfo, clientIp, requestIdFromHeaders } from "./request-info";
