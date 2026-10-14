/**
 * The SaaS plan we sell to operators (D-20, D-22, PLAN §13: "the amounts live in config, not
 * code"). This file is the one place the price, the GST rate, the trial and the grace length are
 * written down; the subscription page, the reminder emails and the public pricing page (T-087)
 * read them from here.
 *
 * The Razorpay plan itself (`RAZORPAY_PLAN_ID`, created by hand in the Razorpay dashboard, H-01)
 * must charge exactly {@link SubscriptionPlan.totalPaise}: checkout refuses to start when the
 * Razorpay plan's amount, currency or interval differ (see `checkout.ts`), so a typo in the
 * dashboard can never charge an operator a different price from the one we show.
 */
import { addPaise, multiplyPaise, type Paise, paise } from "@cb/domain";
import { TRIAL_DAYS } from "../tenants/rules";

/** D-20: days the app keeps working after the trial or a paid month ends without a payment. */
export const GRACE_DAYS = 15;

/** Days before access changes when the Owner gets a reminder email (PLAN §14: T-7, T-1). */
export const REMINDER_DAYS_BEFORE = [7, 1] as const;

export interface SubscriptionPlan {
  /** Stored in `subscriptions.plan_code`. */
  readonly code: string;
  /** Price before GST (D-22: ₹400). */
  readonly pricePaise: Paise;
  /** GST rate in percent (D-22: 18). */
  readonly gstPercent: number;
  /** GST in paise (exact; a rate that doesn't give whole paise is refused at load). */
  readonly gstPaise: Paise;
  /** What Razorpay charges every month (₹472): price + GST. */
  readonly totalPaise: Paise;
  /** Billing interval: every `intervalCount` months. */
  readonly period: "monthly";
  readonly intervalCount: 1;
  /**
   * How many monthly charges one Razorpay subscription (mandate) allows. Razorpay requires a
   * fixed count; 120 months = 10 years. When it runs out the subscription `completes`, the paid
   * month ends without a charge and the Owner is asked to pay again (grace), like any lapse.
   */
  readonly totalCount: number;
  readonly currency: "INR";
}

/** GST on `price` at `percent`, in whole paise. Throws if it is not exact (money is never rounded). */
export function gstOn(price: Paise, percent: number): Paise {
  const scaled = multiplyPaise(price, percent);
  if (scaled % 100 !== 0) {
    throw new RangeError(`GST of ${percent}% on ${price} paise is not a whole number of paise`);
  }
  return paise(scaled / 100);
}

function definePlan(spec: {
  code: string;
  pricePaise: Paise;
  gstPercent: number;
  totalCount: number;
}): SubscriptionPlan {
  const gstPaise = gstOn(spec.pricePaise, spec.gstPercent);
  return Object.freeze({
    ...spec,
    gstPaise,
    totalPaise: addPaise(spec.pricePaise, gstPaise),
    period: "monthly" as const,
    intervalCount: 1 as const,
    currency: "INR" as const,
  });
}

/** D-22: ₹400 + 18% GST = ₹472 a month, unlimited customers (B-018). */
export const MONTHLY_PLAN: SubscriptionPlan = definePlan({
  code: "monthly_400_gst18",
  pricePaise: paise(40_000),
  gstPercent: 18,
  totalCount: 120,
});

/** Every plan we have sold, by code (old codes stay so stored rows keep their meaning). */
export const SUBSCRIPTION_PLANS: Readonly<Record<string, SubscriptionPlan>> = Object.freeze({
  [MONTHLY_PLAN.code]: MONTHLY_PLAN,
});

/** The plan new checkouts use. */
export const CURRENT_PLAN: SubscriptionPlan = MONTHLY_PLAN;

/** The plan for a stored `plan_code` (unknown or empty → the current plan). */
export function planFor(code: string | null | undefined): SubscriptionPlan {
  return (code ? SUBSCRIPTION_PLANS[code] : undefined) ?? CURRENT_PLAN;
}

/** The numbers the public pages and the subscription page print (T-087 reads these). */
export const SUBSCRIPTION_FACTS = Object.freeze({
  pricePaise: CURRENT_PLAN.pricePaise,
  gstPercent: CURRENT_PLAN.gstPercent,
  gstPaise: CURRENT_PLAN.gstPaise,
  totalPaise: CURRENT_PLAN.totalPaise,
  trialDays: TRIAL_DAYS,
  graceDays: GRACE_DAYS,
});
