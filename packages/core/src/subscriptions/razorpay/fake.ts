/**
 * An in-memory Razorpay for tests (core and apps/web): behaves like the Subscriptions API for the
 * calls we make, records every call, and lets a test move a subscription the way Razorpay would
 * (customer authorised, charged, payment failed, cancelled). Never used in production code paths.
 */

import type { RazorpaySubscriptionStatus } from "../state";
import { RazorpayApiError, type RazorpayClient } from "./client";
import type { RazorpayPlanEntity, RazorpaySubscriptionEntity } from "./payload";

export interface FakeRazorpayCall {
  readonly method: keyof RazorpayClient;
  readonly id?: string;
  readonly input?: unknown;
}

export interface FakeRazorpay extends RazorpayClient {
  readonly calls: FakeRazorpayCall[];
  readonly subscriptions: Map<string, RazorpaySubscriptionEntity>;
  /** Adds (or replaces) a plan; default plan `plan_FakeMonthly` = ₹472 monthly. */
  setPlan(plan: RazorpayPlanEntity): void;
  /** Moves a subscription as Razorpay would (e.g. `active` with a new `current_end`). */
  update(
    id: string,
    patch: { status?: RazorpaySubscriptionStatus; currentEnd?: Date | null; currentStart?: Date },
  ): RazorpaySubscriptionEntity;
  /** The next call of `method` throws `error` (default: a 502 from Razorpay). */
  failNext(method: keyof RazorpayClient, error?: Error): void;
}

export const FAKE_PLAN_ID = "plan_FakeMonthly";

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

let instances = 0;

export function createFakeRazorpayClient(
  options: { now?: () => Date; idPrefix?: string } = {},
): FakeRazorpay {
  const now = options.now ?? (() => new Date());
  instances += 1;
  // Unique per client, so tests sharing a database never reuse an id (it is unique per tenant).
  const prefix = options.idPrefix ?? `F${Date.now().toString(36)}${instances}x`;
  const calls: FakeRazorpayCall[] = [];
  const subscriptions = new Map<string, RazorpaySubscriptionEntity>();
  const plans = new Map<string, RazorpayPlanEntity>([
    [
      FAKE_PLAN_ID,
      {
        id: FAKE_PLAN_ID,
        period: "monthly",
        interval: 1,
        item: { amount: 47_200, currency: "INR" },
      },
    ],
  ]);
  const failures = new Map<keyof RazorpayClient, Error>();
  let sequence = 0;

  function maybeFail(method: keyof RazorpayClient): void {
    const error = failures.get(method);
    if (error) {
      failures.delete(method);
      throw error;
    }
  }

  function get(id: string): RazorpaySubscriptionEntity {
    const found = subscriptions.get(id);
    if (!found) throw new RazorpayApiError(400, "BAD_REQUEST_ERROR");
    return found;
  }

  return {
    calls,
    subscriptions,
    setPlan(plan) {
      plans.set(plan.id, plan);
    },
    update(id, patch) {
      const current = get(id);
      const next: RazorpaySubscriptionEntity = {
        ...current,
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.currentEnd !== undefined
          ? { current_end: patch.currentEnd ? seconds(patch.currentEnd) : null }
          : {}),
        ...(patch.currentStart ? { current_start: seconds(patch.currentStart) } : {}),
      };
      subscriptions.set(id, next);
      return next;
    },
    failNext(method, error) {
      failures.set(method, error ?? new RazorpayApiError(502, "SERVER_ERROR"));
    },
    async createSubscription(input) {
      calls.push({ method: "createSubscription", input });
      maybeFail("createSubscription");
      if (!plans.has(input.planId)) throw new RazorpayApiError(400, "BAD_REQUEST_ERROR");
      sequence += 1;
      const id = `sub_${prefix}${String(sequence).padStart(6, "0")}`;
      const entity: RazorpaySubscriptionEntity = {
        id,
        entity: "subscription",
        plan_id: input.planId,
        customer_id: null,
        status: "created",
        current_start: null,
        current_end: null,
        charge_at: input.startAt ? seconds(input.startAt) : null,
        start_at: input.startAt ? seconds(input.startAt) : null,
        end_at: null,
        paid_count: 0,
        total_count: input.totalCount,
        short_url: `https://rzp.io/i/${id}`,
        notes: { ...input.notes },
        created_at: seconds(now()),
      };
      subscriptions.set(id, entity);
      return entity;
    },
    async fetchSubscription(id) {
      calls.push({ method: "fetchSubscription", id });
      maybeFail("fetchSubscription");
      return get(id);
    },
    async cancelSubscription(id, { atCycleEnd }) {
      calls.push({ method: "cancelSubscription", id, input: { atCycleEnd } });
      maybeFail("cancelSubscription");
      const current = get(id);
      if (atCycleEnd) return current;
      const next = { ...current, status: "cancelled" as const };
      subscriptions.set(id, next);
      return next;
    },
    async fetchPlan(id) {
      calls.push({ method: "fetchPlan", id });
      maybeFail("fetchPlan");
      const plan = plans.get(id);
      if (!plan) throw new RazorpayApiError(400, "BAD_REQUEST_ERROR");
      return plan;
    },
  };
}
