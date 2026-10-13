/** Self sign-up and tenant provisioning (T-027). See ./provision.ts and ./signup.ts. */
export {
  type BotCheck,
  createTurnstileVerifier,
  disabledBotCheck,
  TURNSTILE_RESPONSE_FIELD,
  TURNSTILE_VERIFY_URL,
  type TurnstileVerifierOptions,
} from "./bot-check";
export {
  type ProvisionActor,
  type ProvisionConflict,
  type ProvisionError,
  type ProvisionedTenant,
  type ProvisionFailureReason,
  type ProvisionTenantInput,
  provisionTenant,
} from "./provision";
export {
  MAX_LOGIN_CANDIDATES,
  normalizeIndianMobile,
  ownerLoginCandidates,
  TRIAL_DAYS,
  trialEndsAt,
  trialLastDay,
} from "./rules";
export {
  type CompletedSignup,
  type CreateSignupServiceOptions,
  createSignupService,
  type PendingSignupView,
  SIGNUP_FIELD_LIMITS,
  SIGNUP_IDENTIFIER_PREFIX,
  SIGNUP_LINK_TTL_SECONDS,
  SIGNUP_RATE_LIMITS,
  type SignupEmail,
  type SignupFailure,
  type SignupField,
  type SignupFieldProblem,
  type SignupService,
  type SignupStartInput,
  signupIdentifier,
  validateSignupFields,
} from "./signup";
