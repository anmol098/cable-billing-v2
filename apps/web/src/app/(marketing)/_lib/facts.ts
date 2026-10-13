/**
 * The business facts the public pages state, in one place (T-087). Every number here comes from a
 * decision in docs/IMPLEMENTATION_PLAN.md §1.1; the pages never write a number of their own.
 *
 * The subscription numbers are duplicated from the plan until T-085 adds the config-driven plan
 * (`packages/core/src/subscriptions`, PLAN §13 "the amounts live in config"). When it lands, read
 * them from there instead and delete the constants below.
 */
import { RECEIPT_LINK_TTL_DAYS } from "@cb/core";
import {
  addPaise,
  type BusinessDate,
  businessDate,
  formatINR,
  multiplyPaise,
  type Paise,
  paise,
} from "@cb/domain";

/** D-22: ₹400 a month, before GST. */
export const SUBSCRIPTION_PRICE_PAISE: Paise = paise(40_000);

/** D-22: GST charged on our fee, in percent. */
export const GST_PERCENT = 18;

/** D-20: length of the free trial after sign-up. */
export const TRIAL_DAYS = 30;

/** D-20: days the app keeps working after a missed payment, before view-only mode. */
export const GRACE_DAYS = 15;

/**
 * Date printed on the privacy policy and terms drafts ("Draft of 13 Oct 2026"). Change it whenever
 * their text changes.
 */
export const LEGAL_DRAFT_DATE: BusinessDate = businessDate("2026-10-13");

/** GST on `price` at `percent`, in whole paise. Throws if it is not exact (never rounds money). */
export function gstOn(price: Paise, percent: number): Paise {
  const scaled = multiplyPaise(price, percent);
  if (scaled % 100 !== 0) {
    throw new RangeError(`GST of ${percent}% on ${price} paise is not a whole number of paise`);
  }
  return paise(scaled / 100);
}

/** The words-ready values the pages pass to their messages (`{price}`, `{total}`, …). */
export type MarketingFacts = {
  /** `"₹400"` */
  price: string;
  /** `"₹72"` */
  gst_amount: string;
  /** `"₹472"` */
  total: string;
  /** `18` */
  gst: number;
  /** Trial days, `30`. */
  days: number;
  /** Grace days, `15`. */
  grace: number;
};

export function marketingFacts(): MarketingFacts {
  const gst = gstOn(SUBSCRIPTION_PRICE_PAISE, GST_PERCENT);
  return {
    price: formatINR(SUBSCRIPTION_PRICE_PAISE),
    gst_amount: formatINR(gst),
    total: formatINR(addPaise(SUBSCRIPTION_PRICE_PAISE, gst)),
    gst: GST_PERCENT,
    days: TRIAL_DAYS,
    grace: GRACE_DAYS,
  };
}

/** D-14 / T-050: how long a public receipt link works. */
export const RECEIPT_LINK_DAYS = RECEIPT_LINK_TTL_DAYS;
