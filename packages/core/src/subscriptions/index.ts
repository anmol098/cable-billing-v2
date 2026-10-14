/**
 * Our SaaS subscription (T-085, PLAN §13, FR-025, D-12, D-13, D-20, D-22, D-25): the configured
 * plan, the state machine, Razorpay (client, signatures, webhooks, reconciliation, checkout), the
 * daily cron and the Owner's reminder emails. See the T-085 completion notes for the flows.
 */
export {
  type CheckoutConfig,
  type CheckoutError,
  type CheckoutErrorCode,
  type ConfirmCheckoutInput,
  confirmSubscriptionCheckout,
  firstChargeAt,
  planMatches,
  type StartCheckoutResult,
  startSubscriptionCheckout,
} from "./checkout";
export {
  runSubscriptionStates,
  SubscriptionStatesError,
  type SubscriptionStatesOptions,
  type SubscriptionStatesReport,
} from "./daily";
export {
  type NoticeRecipient,
  noticeAlreadySent,
  noticeRecipients,
  type RenderSubscriptionNotice,
  type RenderSubscriptionNoticeArgs,
  type SendNoticeResult,
  type SubscriptionNotifier,
  sendSubscriptionNotice,
} from "./notices";
export {
  CURRENT_PLAN,
  GRACE_DAYS,
  gstOn,
  MONTHLY_PLAN,
  planFor,
  REMINDER_DAYS_BEFORE,
  SUBSCRIPTION_FACTS,
  SUBSCRIPTION_PLANS,
  type SubscriptionPlan,
} from "./plan";
export {
  type CreateRazorpaySubscriptionInput,
  createRazorpayClient,
  RAZORPAY_API_BASE_URL,
  RazorpayApiError,
  type RazorpayClient,
  type RazorpayRestClientOptions,
} from "./razorpay/client";
export {
  createFakeRazorpayClient,
  FAKE_PLAN_ID,
  type FakeRazorpay,
  type FakeRazorpayCall,
} from "./razorpay/fake";
export {
  fromUnix,
  RazorpayPlanEntity,
  RazorpaySubscriptionEntity,
  RazorpayWebhookBody,
  snapshotOf,
} from "./razorpay/payload";
export {
  razorpayHmac,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from "./razorpay/signature";
export { needsReconcile, type ReconcileResult, reconcileWithRazorpay } from "./reconcile";
export {
  type AutopayState,
  autopayOf,
  RecordCheckoutSubscriptionInput,
  recordCheckoutSubscription,
  SubscriptionOverviewInput,
  type SubscriptionPlanView,
  type SubscriptionView,
  subscriptionOverview,
  subscriptionViewOf,
} from "./services";
export {
  AUTOPAY_ON_STATUSES,
  daysUntil,
  dueNotice,
  graceEndsAt,
  isRazorpaySubscriptionStatus,
  istMidnightOnOrAfter,
  lastDayBefore,
  nextSubscriptionState,
  type RazorpaySnapshot,
  type RazorpaySubscriptionStatus,
  reactivatedNotice,
  type SubscriptionChange,
  type SubscriptionNotice,
  type SubscriptionNoticeKind,
  type SubscriptionState,
  type SubscriptionStep,
} from "./state";
export {
  type ApplyChangeOptions,
  type ApplyChangeResult,
  applySubscriptionChange,
  missedRunPeriods,
  readSubscription,
  type StoredSubscription,
  type SubscriptionActor,
} from "./store";
export {
  handleRazorpayWebhook,
  RAZORPAY_WEBHOOK_MAX_BYTES,
  type RazorpayWebhookDeps,
  type RazorpayWebhookOutcome,
  type RazorpayWebhookRequest,
  type RazorpayWebhookResult,
} from "./webhook";
