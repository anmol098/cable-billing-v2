/**
 * Razorpay Subscriptions REST API (documented endpoints, no SDK): HTTP Basic auth with the key id
 * and secret, JSON bodies, `https://api.razorpay.com/v1`.
 *
 * | Method | Endpoint |
 * |---|---|
 * | `createSubscription` | `POST /subscriptions` |
 * | `fetchSubscription` | `GET /subscriptions/{id}` |
 * | `cancelSubscription` | `POST /subscriptions/{id}/cancel` (`cancel_at_cycle_end` 0/1) |
 * | `fetchPlan` | `GET /plans/{id}` |
 *
 * Everything that talks to Razorpay takes a {@link RazorpayClient}, so tests and the e2e suite use
 * {@link createFakeRazorpayClient} (or a local mock server through `baseUrl`) and never call the
 * real API. Errors carry the HTTP status and Razorpay's error code only (descriptions can echo
 * customer details).
 */
import {
  RazorpayPlanEntity,
  type RazorpayPlanEntity as RazorpayPlanEntityType,
  RazorpaySubscriptionEntity,
  type RazorpaySubscriptionEntity as RazorpaySubscriptionEntityType,
} from "./payload";

export const RAZORPAY_API_BASE_URL = "https://api.razorpay.com/v1";

export interface CreateRazorpaySubscriptionInput {
  readonly planId: string;
  /** Number of monthly charges the mandate allows. */
  readonly totalCount: number;
  /** First charge; omitted = right after the customer authorises. */
  readonly startAt?: Date;
  /** Razorpay emails/SMSes the customer about charges itself. */
  readonly customerNotify: boolean;
  /** Echoed back in webhooks (ids only, never personal data). */
  readonly notes: Readonly<Record<string, string>>;
}

export interface RazorpayClient {
  createSubscription(
    input: CreateRazorpaySubscriptionInput,
  ): Promise<RazorpaySubscriptionEntityType>;
  fetchSubscription(id: string): Promise<RazorpaySubscriptionEntityType>;
  cancelSubscription(
    id: string,
    options: { readonly atCycleEnd: boolean },
  ): Promise<RazorpaySubscriptionEntityType>;
  fetchPlan(id: string): Promise<RazorpayPlanEntityType>;
}

/** Razorpay refused a request, or answered something we can't read. */
export class RazorpayApiError extends Error {
  readonly status: number;
  /** Razorpay's `error.code` (e.g. `BAD_REQUEST_ERROR`), or `invalid_response` / `network`. */
  readonly code: string;
  constructor(status: number, code: string) {
    super(`Razorpay API error ${status} ${code}`);
    this.name = "RazorpayApiError";
    this.status = status;
    this.code = code;
  }
}

export interface RazorpayRestClientOptions {
  readonly keyId: string;
  readonly keySecret: string;
  /** Default {@link RAZORPAY_API_BASE_URL}; a local mock server in the e2e suite. */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  /** Default 10 s. */
  readonly timeoutMs?: number;
}

const ID = /^[A-Za-z0-9_]{1,60}$/;

function checkId(id: string): string {
  if (!ID.test(id)) throw new RazorpayApiError(0, "invalid_id");
  return id;
}

export function createRazorpayClient(options: RazorpayRestClientOptions): RazorpayClient {
  const doFetch = options.fetch ?? fetch;
  const base = (options.baseUrl ?? RAZORPAY_API_BASE_URL).replace(/\/+$/, "");
  const auth = `Basic ${Buffer.from(`${options.keyId}:${options.keySecret}`).toString("base64")}`;

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    parse: (json: unknown) => T,
  ): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: auth,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch {
      throw new RazorpayApiError(0, "network");
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new RazorpayApiError(response.status, "invalid_response");
    }
    if (!response.ok) {
      const code =
        typeof json === "object" &&
        json !== null &&
        "error" in json &&
        typeof (json as { error?: { code?: unknown } }).error?.code === "string"
          ? String((json as { error: { code: string } }).error.code)
          : "http_error";
      throw new RazorpayApiError(response.status, code.replace(/[^A-Za-z0-9_]/g, "").slice(0, 60));
    }
    try {
      return parse(json);
    } catch {
      throw new RazorpayApiError(response.status, "invalid_response");
    }
  }

  return {
    createSubscription(input) {
      return call(
        "POST",
        "/subscriptions",
        {
          plan_id: checkId(input.planId),
          total_count: input.totalCount,
          quantity: 1,
          customer_notify: input.customerNotify ? 1 : 0,
          ...(input.startAt ? { start_at: Math.floor(input.startAt.getTime() / 1000) } : {}),
          notes: input.notes,
        },
        (json) => RazorpaySubscriptionEntity.parse(json),
      );
    },
    fetchSubscription(id) {
      return call("GET", `/subscriptions/${checkId(id)}`, undefined, (json) =>
        RazorpaySubscriptionEntity.parse(json),
      );
    },
    cancelSubscription(id, { atCycleEnd }) {
      return call(
        "POST",
        `/subscriptions/${checkId(id)}/cancel`,
        { cancel_at_cycle_end: atCycleEnd ? 1 : 0 },
        (json) => RazorpaySubscriptionEntity.parse(json),
      );
    },
    fetchPlan(id) {
      return call("GET", `/plans/${checkId(id)}`, undefined, (json) =>
        RazorpayPlanEntity.parse(json),
      );
    },
  };
}
