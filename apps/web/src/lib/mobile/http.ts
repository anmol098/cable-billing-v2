/**
 * HTTP plumbing for `/api/mobile/v1` (T-028; used by T-060 and T-061 too).
 *
 * - Every body in and out is checked against the contract (`@cb/contracts` `ENDPOINTS`): requests
 *   with the endpoint's `body` schema (400 VALIDATION with `fields`), responses with its `response`
 *   schema before they leave (a response that doesn't match is a server bug: logged, 500 INTERNAL).
 * - Every response carries `server_time`, `Cache-Control: no-store` and, on errors, the request id.
 * - Errors use the contract's codes and HTTP statuses (`httpStatusForError`); RATE_LIMITED also
 *   sends `Retry-After`, APP_TOO_OLD `min_app_version_code`.
 * - Unexpected exceptions become 500 INTERNAL (logged with ids only, sent to Sentry).
 *
 * Bearer endpoints use {@link withMobileAuth}:
 *
 * ```ts
 * // apps/web/src/app/api/mobile/v1/sync/customers/route.ts (T-060)
 * import { ENDPOINTS } from "@cb/contracts";
 * import { withMobileAuth } from "@/lib/mobile/http";
 * import { getMobileDeps } from "@/lib/mobile/server";
 *
 * export const runtime = "nodejs";
 * export const dynamic = "force-dynamic";
 * export const GET = withMobileAuth(ENDPOINTS.syncCustomers, getMobileDeps, async ({ ctx, deps, reply }) => {
 *   const result = await someService.call(deps.runtime, ctx, input);
 *   if (!result.ok) return reply.serviceError(result.error);
 *   return reply.ok({ customers: …, next_cursor: …, has_more: false });
 * });
 * ```
 */

import { type Endpoint, type ErrorCode, httpStatusForError, isErrorCode } from "@cb/contracts";
import {
  errorLogFields,
  type Logger,
  type MobileAuthentication,
  type MobileAuthFailure,
  type MobileAuthService,
  type MobileRequestMeta,
  requestIdFromHeaders,
  type ServiceError,
  type ServiceRuntime,
  type TenantContext,
} from "@cb/core";
import * as Sentry from "@sentry/nextjs";
import type * as z from "zod";

/** What the mobile routes need; production: `getMobileDeps` from `./server`. */
export interface MobileDeps {
  readonly auth: MobileAuthService;
  readonly runtime: ServiceRuntime;
  readonly logger: Logger;
  /**
   * Runs `task` after the response is sent (production: Next's `after`). Omitted (tests): a route
   * runs the task inline before answering, so its effects are visible when the call returns.
   */
  readonly afterResponse?: (task: () => Promise<void>) => void;
}

export interface FieldProblem {
  readonly path: string;
  readonly issue: string;
}

export interface ErrorExtras {
  readonly fields?: readonly FieldProblem[];
  readonly minAppVersionCode?: number;
  readonly retryAfterSeconds?: number;
}

/** The response body without `server_time` (added here). */
export type ReplyBody<E extends Endpoint> = Omit<z.input<E["response"]>, "server_time">;

export interface Reply<E extends Endpoint> {
  /** 200 with the endpoint's response, validated against the contract. */
  ok(body: ReplyBody<E>): Response;
  /** An error response with a contract code. `message` is for developers: never PII. */
  error(code: ErrorCode, message?: string, extras?: ErrorExtras): Response;
  /** A mobile auth failure (from `@cb/core` `MobileAuthService`). */
  authFailure(failure: MobileAuthFailure): Response;
  /** A service error (`service.call` result): its code if the contract knows it, else by kind. */
  serviceError(error: ServiceError<string>): Response;
}

export interface MobileScope<E extends Endpoint> {
  readonly request: Request;
  readonly requestId: string;
  /** Logger with `request_id` (and `endpoint`) bound. */
  readonly log: Logger;
  readonly deps: MobileDeps;
  /** Headers + request id, for `MobileAuthService` calls. */
  readonly meta: MobileRequestMeta;
  readonly reply: Reply<E>;
}

export interface AuthenticatedScope<E extends Endpoint, P> extends MobileScope<E> {
  /** channel `mobile`, `deviceId` set: pass it to `service.call`. */
  readonly ctx: TenantContext;
  readonly authentication: MobileAuthentication;
  readonly params: P;
}

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

function serverTime(deps: MobileDeps): string {
  return deps.runtime.now().toISOString();
}

/** `ErrorResponse` body + status for a contract error code. */
export function errorResponse(
  code: ErrorCode,
  options: {
    readonly requestId: string;
    readonly serverTime: string;
    readonly message?: string;
    readonly extras?: ErrorExtras;
  },
): Response {
  const { extras } = options;
  const error = {
    code,
    message: (options.message ?? code.toLowerCase()).slice(0, 1000),
    request_id: options.requestId,
    ...(extras?.fields && extras.fields.length > 0 ? { fields: [...extras.fields] } : {}),
    ...(code === "APP_TOO_OLD" && extras?.minAppVersionCode
      ? { min_app_version_code: extras.minAppVersionCode }
      : {}),
    ...(code === "RATE_LIMITED" && extras?.retryAfterSeconds
      ? { retry_after_seconds: Math.max(1, Math.ceil(extras.retryAfterSeconds)) }
      : {}),
  };
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (error.retry_after_seconds) headers["Retry-After"] = String(error.retry_after_seconds);
  return new Response(JSON.stringify({ server_time: options.serverTime, error }), {
    status: httpStatusForError(code),
    headers,
  });
}

/** Zod issues → contract `FieldIssue`s (paths only, never values). */
export function fieldProblems(error: z.ZodError, prefix?: string): FieldProblem[] {
  return error.issues.slice(0, 50).map((issue) => {
    const path = issue.path.map(String).join(".");
    return {
      path: [prefix, path].filter(Boolean).join(".") || (prefix ?? "body"),
      issue: issue.code,
    };
  });
}

function makeReply<E extends Endpoint>(
  endpoint: E,
  deps: MobileDeps,
  requestId: string,
  log: Logger,
): Reply<E> {
  const error: Reply<E>["error"] = (code, message, extras) =>
    errorResponse(code, {
      requestId,
      serverTime: serverTime(deps),
      ...(message ? { message } : {}),
      ...(extras ? { extras } : {}),
    });
  return {
    ok(body) {
      const parsed = endpoint.response.safeParse({ server_time: serverTime(deps), ...body });
      if (!parsed.success) {
        log.error("mobile_api.response_invalid", {
          operation: endpoint.operationId,
          issues: parsed.error.issues.length,
          first_path: parsed.error.issues[0]?.path.map(String).join(".") ?? "",
        });
        return error("INTERNAL", "response did not match the contract");
      }
      return new Response(JSON.stringify(parsed.data), { status: 200, headers: JSON_HEADERS });
    },
    error,
    authFailure(failure) {
      return error(
        failure.code,
        failure.reason ? `${failure.code.toLowerCase()}: ${failure.reason}` : undefined,
        {
          ...(failure.fields ? { fields: failure.fields } : {}),
          ...(failure.minAppVersionCode ? { minAppVersionCode: failure.minAppVersionCode } : {}),
          ...(failure.retryAfterSeconds ? { retryAfterSeconds: failure.retryAfterSeconds } : {}),
        },
      );
    },
    serviceError(serviceError) {
      const code = isErrorCode(serviceError.code) ? serviceError.code : "INTERNAL";
      const fields = (serviceError.details as { fields?: unknown } | undefined)?.fields;
      const problems = Array.isArray(fields)
        ? fields
            .filter(
              (f): f is { path: string; code: string } =>
                typeof f?.path === "string" && typeof f?.code === "string",
            )
            .map((f) => ({ path: f.path, issue: f.code }))
        : undefined;
      return error(
        code,
        (serviceError.message ?? "").slice(0, 200) || undefined,
        problems ? { fields: problems } : {},
      );
    },
  };
}

/**
 * Reads and validates a JSON body with `schema`. On failure, `response` is the 400 VALIDATION
 * answer (with `fields`).
 */
export async function readJsonBody<S extends z.ZodType>(
  scope: MobileScope<Endpoint>,
  schema: S,
): Promise<{ ok: true; value: z.infer<S> } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await scope.request.json();
  } catch {
    return {
      ok: false,
      response: scope.reply.error("VALIDATION", "body is not JSON", {
        fields: [{ path: "body", issue: "invalid_json" }],
      }),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: scope.reply.error("VALIDATION", "body does not match the contract", {
        fields: fieldProblems(parsed.error),
      }),
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * A route handler for `endpoint` without bearer auth (login, refresh, logout). Adds the request
 * id, the logger, the reply helpers and the INTERNAL safety net.
 */
export function mobileRoute<E extends Endpoint>(
  endpoint: E,
  getDeps: () => MobileDeps,
  handler: (scope: MobileScope<E>) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const requestId = requestIdFromHeaders(request.headers);
    let deps: MobileDeps;
    try {
      deps = getDeps();
    } catch (error) {
      Sentry.captureException(error);
      return errorResponse("INTERNAL", {
        requestId,
        serverTime: new Date().toISOString(),
        message: "server not configured",
      });
    }
    const log = deps.logger.child({ request_id: requestId, endpoint: endpoint.operationId });
    const reply = makeReply(endpoint, deps, requestId, log);
    try {
      return await handler({
        request,
        requestId,
        log,
        deps,
        meta: { headers: request.headers, requestId },
        reply,
      });
    } catch (error) {
      log.error("mobile_api.failed", errorLogFields(error));
      Sentry.captureException(error, { tags: { endpoint: endpoint.operationId } });
      return reply.error("INTERNAL", "unexpected server error");
    }
  };
}

/**
 * A bearer endpoint: verifies the access token, applies the force-update gate (unless the
 * contract marks the endpoint `appVersionGate: false`, i.e. `/app/config`) and builds the
 * TenantContext (`resolveTenantContext`, channel `mobile`, the token's device). Failures answer
 * UNAUTHENTICATED / DEVICE_REVOKED (401), ACCOUNT_DISABLED / ROLE_NOT_ALLOWED (403),
 * APP_TOO_OLD (426) or VALIDATION (missing version header) before `handler` runs.
 */
export function withMobileAuth<E extends Endpoint, P = Record<string, string>>(
  endpoint: E,
  getDeps: () => MobileDeps,
  handler: (scope: AuthenticatedScope<E, P>) => Promise<Response>,
): (request: Request, context?: { params?: Promise<P> }) => Promise<Response> {
  return async (request, context) => {
    let params = {} as P;
    if (context?.params) params = await context.params;
    return mobileRoute(endpoint, getDeps, async (scope) => {
      const authentication = await scope.deps.auth.authenticate(scope.meta, {
        appVersionGate: endpoint.appVersionGate,
      });
      if (!authentication.ok) {
        scope.log.info("mobile_api.unauthenticated", {
          code: authentication.error.code,
          reason: authentication.error.reason ?? "",
        });
        return scope.reply.authFailure(authentication.error);
      }
      const { ctx } = authentication.value;
      const log = scope.log.child({
        operator_id: ctx.operatorId,
        user_id: ctx.userId,
        device_id: ctx.deviceId ?? "",
      });
      return handler({ ...scope, log, ctx, authentication: authentication.value, params });
    })(request);
  };
}
