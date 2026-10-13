/**
 * Every endpoint of `/api/mobile/v1` (PLAN §10.2) in one table: method, path, schemas and the
 * whole-request error codes it can return. `openapi.ts` renders this table; route handlers (T-028,
 * T-060, T-061) use the same entries to validate input and output.
 */

import * as z from "zod";
import { AppConfigResponse } from "./app-config";
import {
  LoginRequest,
  LoginResponse,
  LogoutRequest,
  LogoutResponse,
  RefreshRequest,
  RefreshResponse,
} from "./auth";
import {
  CollectionDateParams,
  CollectionDayResponse,
  HandoverRequest,
  HandoverResponse,
} from "./collections";
import {
  CustomerDetailResponse,
  CustomerIdParams,
  UpdatePhoneRequest,
  UpdatePhoneResponse,
} from "./customers";
import type { ErrorCode } from "./errors";
import { PaymentBatchRequest, PaymentBatchResponse } from "./payments";
import {
  ReceiptActionsRequest,
  ReceiptActionsResponse,
  ReceiptLinkParams,
  ReceiptLinkResponse,
} from "./receipts";
import { SyncCustomersQuery, SyncCustomersResponse } from "./sync";

/** Path prefix of the mobile API on the web app (D-01). */
export const MOBILE_API_BASE_PATH = "/api/mobile/v1";

/**
 * Contract version (semver). Additive changes bump the minor, documentation-only changes the patch.
 * A breaking change is a new `/api/mobile/v2`, never a change here (see README).
 */
export const CONTRACT_VERSION = "1.0.0";

/** Header the app sends on every request: its Android versionCode (force-update gate, T-028). */
export const APP_VERSION_HEADER = "x-app-version-code";

export const AppVersionHeaders = z.object({
  [APP_VERSION_HEADER]: z
    .string()
    .regex(/^[1-9][0-9]{0,9}$/)
    .describe(
      "The app's Android versionCode, as decimal digits. Sent on every request; if it is below min_app_version_code the server answers APP_TOO_OLD (except GET /app/config and POST /auth/logout, which always answer).",
    ),
});

export const TAGS = {
  auth: "Sign-in and tokens (T-028).",
  app: "App configuration and the force-update gate (T-028).",
  customers: "Roster sync, customer detail and phone correction (T-060).",
  payments: "Pushing payments saved on the phone (T-061).",
  collections: "The lineman's day and cash handover (T-061, T-062).",
  receipts: "Receipt preview links and receipt actions (T-061, T-050).",
} as const;

export type Tag = keyof typeof TAGS;

export type Endpoint = {
  readonly operationId: string;
  readonly method: "get" | "post" | "patch";
  /** OpenAPI path under {@link MOBILE_API_BASE_PATH}, with `{param}` placeholders. */
  readonly path: string;
  readonly tag: Tag;
  readonly summary: string;
  readonly description: string;
  /** `bearer`: needs `Authorization: Bearer <access_token>`. */
  readonly auth: "bearer" | "none";
  /** False only for the endpoints that must answer old apps (config, logout). */
  readonly appVersionGate: boolean;
  readonly params?: z.ZodObject;
  readonly query?: z.ZodObject;
  readonly body?: z.ZodType;
  readonly response: z.ZodType;
  /** Endpoint-specific whole-request error codes (common ones are added by {@link errorCodesOf}). */
  readonly errors: readonly ErrorCode[];
};

export const ENDPOINTS = {
  login: {
    operationId: "login",
    method: "post",
    path: "/auth/login",
    tag: "auth",
    summary: "Sign in a lineman on this phone",
    description:
      "Lineman role only (owners and staff get ROLE_NOT_ALLOWED). Registers or updates the device (install_id, model, app version), assigns its device_code and returns a token pair. Rate limited.",
    auth: "none",
    appVersionGate: true,
    body: LoginRequest,
    response: LoginResponse,
    errors: ["INVALID_CREDENTIALS", "ACCOUNT_DISABLED", "ROLE_NOT_ALLOWED"],
  },
  refreshTokens: {
    operationId: "refreshTokens",
    method: "post",
    path: "/auth/refresh",
    tag: "auth",
    summary: "Rotate the token pair",
    description:
      "Single-use refresh tokens: each call returns a new pair. A reused or unknown token revokes its family (REFRESH_TOKEN_INVALID); a phone the owner signed out gets DEVICE_REVOKED. On either, go to the login screen and keep every queued payment.",
    auth: "none",
    appVersionGate: true,
    body: RefreshRequest,
    response: RefreshResponse,
    errors: ["REFRESH_TOKEN_INVALID", "DEVICE_REVOKED", "ACCOUNT_DISABLED"],
  },
  logout: {
    operationId: "logout",
    method: "post",
    path: "/auth/logout",
    tag: "auth",
    summary: "Sign this phone out",
    description:
      "Revokes the refresh token's family. Always succeeds for a well-formed request, even if the token is already gone.",
    auth: "none",
    appVersionGate: false,
    body: LogoutRequest,
    response: LogoutResponse,
    errors: [],
  },
  getAppConfig: {
    operationId: "getAppConfig",
    method: "get",
    path: "/app/config",
    tag: "app",
    summary: "App configuration and force-update gate",
    description:
      "Read on app start and after each sync. Never answers APP_TOO_OLD: compare min_app_version_code with the installed versionCode instead (PLAN §11.9).",
    auth: "bearer",
    appVersionGate: false,
    response: AppConfigResponse,
    errors: [],
  },
  syncCustomers: {
    operationId: "syncCustomers",
    method: "get",
    path: "/sync/customers",
    tag: "customers",
    summary: "Delta sync of the customer roster",
    description:
      "Pages through roster changes ordered by (updated_at, id) with tombstones (PLAN §10.3). Pull on app open, every 30 minutes and after every payment push. CURSOR_INVALID → start a full sync.",
    auth: "bearer",
    appVersionGate: true,
    query: SyncCustomersQuery,
    response: SyncCustomersResponse,
    errors: ["CURSOR_INVALID"],
  },
  getCustomer: {
    operationId: "getCustomer",
    method: "get",
    path: "/customers/{id}",
    tag: "customers",
    summary: "Fresh customer detail",
    description:
      "Open bills and latest payments for the customer screen when online. Offline, the app shows the cached roster row instead.",
    auth: "bearer",
    appVersionGate: true,
    params: CustomerIdParams,
    response: CustomerDetailResponse,
    errors: ["CUSTOMER_NOT_FOUND"],
  },
  updateCustomerPhone: {
    operationId: "updateCustomerPhone",
    method: "patch",
    path: "/customers/{id}/phone",
    tag: "customers",
    summary: "Correct the customer's phone number",
    description:
      "From the receipt flow after the lineman confirms the number (FR-004). Audited with old and new value, actor and source 'android'. Idempotent: sending the current number again changes nothing.",
    auth: "bearer",
    appVersionGate: true,
    params: CustomerIdParams,
    body: UpdatePhoneRequest,
    response: UpdatePhoneResponse,
    errors: ["CUSTOMER_NOT_FOUND", "TENANT_READ_ONLY"],
  },
  postPaymentBatch: {
    operationId: "postPaymentBatch",
    method: "post",
    path: "/payments:batch",
    tag: "payments",
    summary: "Push queued payments",
    description:
      "Up to 50 payments saved on the phone, each posted idempotently on its id (PLAN §8.4, §10.4). Per-item outcomes are in the 200 body; a bad item is rejected on its own and does not fail the batch. Accepted in read-only mode (D-13). Retrofit note: write the relative URL as './payments:batch' (a bare 'payments:batch' parses as a URL scheme).",
    auth: "bearer",
    appVersionGate: true,
    body: PaymentBatchRequest,
    response: PaymentBatchResponse,
    errors: [],
  },
  getCollectionDay: {
    operationId: "getCollectionDay",
    method: "get",
    path: "/collections/{date}",
    tag: "collections",
    summary: "The lineman's totals for a day",
    description:
      "Server-known cash and UPI totals, payments and handover status for the signed-in lineman on one India-time business date (FR-022).",
    auth: "bearer",
    appVersionGate: true,
    params: CollectionDateParams,
    response: CollectionDayResponse,
    errors: [],
  },
  submitHandover: {
    operationId: "submitHandover",
    method: "post",
    path: "/collections/{date}/handover",
    tag: "collections",
    summary: "Submit the day's cash handover",
    description:
      "The server computes the expected cash and the discrepancy (PLAN §8.7). A reason is required when they differ. Idempotent on submission_id. Accepted in read-only mode (D-13).",
    auth: "bearer",
    appVersionGate: true,
    params: CollectionDateParams,
    body: HandoverRequest,
    response: HandoverResponse,
    errors: ["HANDOVER_ALREADY_ACCEPTED", "ID_REUSED_WITH_DIFFERENT_DATA"],
  },
  createReceiptLink: {
    operationId: "createReceiptLink",
    method: "post",
    path: "/receipts/{paymentId}/link",
    tag: "receipts",
    summary: "Get a receipt preview link",
    description:
      "Creates or returns the secure preview link for a synced payment (FR-021). No request body. Online only; offline the app queues the WhatsApp/SMS action with 'Link will be ready after sync'.",
    auth: "bearer",
    appVersionGate: true,
    params: ReceiptLinkParams,
    response: ReceiptLinkResponse,
    errors: ["PAYMENT_NOT_FOUND"],
  },
  postReceiptActions: {
    operationId: "postReceiptActions",
    method: "post",
    path: "/receipts/actions:batch",
    tag: "receipts",
    summary: "Record what was done with receipts",
    description:
      "Printed, print failed, WhatsApp opened, SMS opened, PDF shared: observable states only, never 'sent' or 'delivered' (RULE-19). Idempotent per action id; per-item outcomes in the 200 body.",
    auth: "bearer",
    appVersionGate: true,
    body: ReceiptActionsRequest,
    response: ReceiptActionsResponse,
    errors: [],
  },
} as const satisfies Record<string, Endpoint>;

export type OperationId = keyof typeof ENDPOINTS;

/** All endpoints as a list, in table order. */
export const ENDPOINT_LIST: readonly Endpoint[] = Object.values(ENDPOINTS);

/**
 * Every whole-request error code an endpoint can return: its own codes plus the common ones
 * (validation, auth, version gate, rate limit, server errors).
 */
export function errorCodesOf(endpoint: Endpoint): ErrorCode[] {
  // VALIDATION always: every request carries at least the app-version header.
  const codes: ErrorCode[] = ["VALIDATION"];
  if (endpoint.auth === "bearer") codes.push("UNAUTHENTICATED", "FORBIDDEN");
  if (endpoint.appVersionGate) codes.push("APP_TOO_OLD");
  codes.push(...endpoint.errors, "RATE_LIMITED", "INTERNAL");
  if (endpoint.method !== "get") codes.push("INVARIANT_VIOLATION");
  return [...new Set(codes)];
}
