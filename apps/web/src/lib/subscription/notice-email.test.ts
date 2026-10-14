// @vitest-environment node
/**
 * The subscription emails' words (T-085): every kind in English and Hindi, the last day in IST,
 * the price in whole rupees, the missed bill months, the link, and honest wording (never "failed",
 * never "sent"/"delivered").
 */
import { dueNotice, MONTHLY_PLAN, reactivatedNotice, type SubscriptionState } from "@cb/core";
import { describe, expect, it } from "vitest";
import { missedMonthsText, renderSubscriptionNotice } from "./notice-email";

const base: SubscriptionState = {
  status: "trialing",
  trialEndsAt: new Date("2026-11-12T18:30:00Z"),
  currentPeriodEnd: null,
  graceEndsAt: null,
  cancelledAt: null,
  razorpaySubscriptionId: null,
  razorpayStatus: null,
  razorpayStatusAt: null,
};

const render = (
  state: SubscriptionState,
  now: string,
  language: "en" | "hi",
  missed: string[] = [],
) => {
  const notice =
    state.status === "active"
      ? reactivatedNotice(state, new Date(now))
      : dueNotice(state, new Date(now));
  if (!notice) throw new Error("no notice due");
  return renderSubscriptionNotice({
    language,
    notice,
    plan: MONTHLY_PLAN,
    missedRunPeriods: missed,
  });
};

describe("subscription emails", () => {
  it("trial ending (T-7): the last free day and the monthly price", async () => {
    const email = await render(base, "2026-11-06T00:30:00Z", "en");
    expect(email.subject).toBe("Your Cable Billing free trial ends on 12 Nov 2026");
    expect(email.text).toContain("pay ₹472 a month (UPI Autopay or card)");
    expect(email.text).toContain("Open: http://localhost:3000/settings/subscription");
    expect(email.text).toContain("Your data is never deleted.");
  });

  it("grace started and ending, in Hindi", async () => {
    const grace = {
      ...base,
      status: "grace" as const,
      graceEndsAt: new Date("2026-11-27T18:30:00Z"),
    };
    const started = await render(grace, "2026-11-13T00:30:00Z", "hi");
    expect(started.subject).toBe("कृपया 27 नव 2026 तक केबल बिलिंग का पेमेंट करें");
    const ending = await render(grace, "2026-11-26T00:30:00Z", "hi");
    expect(ending.subject).toBe("27 नव 2026 के बाद केबल बिलिंग सिर्फ़ देखने के लिए होगा");
    expect(ending.text).toContain("₹472");
  });

  it("working again: the paid-till day and the missed bill months, linking to Bills", async () => {
    const active = {
      ...base,
      status: "active" as const,
      currentPeriodEnd: new Date("2026-12-28T05:00:00Z"),
    };
    const email = await render(active, "2026-11-28T05:00:00Z", "en", ["2026-10-01", "2026-11-01"]);
    expect(email.subject).toBe("Cable Billing is working again");
    expect(email.text).toContain("paid till 28 Dec 2026");
    expect(email.text).toContain("October 2026, November 2026");
    expect(email.text).toContain("/bills/runs");
    expect(missedMonthsText(["2026-10-01"], "hi")).toBe("अक्टूबर 2026");
  });

  it("never claims a failure or a delivery it can't know", async () => {
    const grace = {
      ...base,
      status: "grace" as const,
      graceEndsAt: new Date("2026-11-27T18:30:00Z"),
    };
    for (const language of ["en", "hi"] as const) {
      for (const now of ["2026-11-13T00:30:00Z", "2026-11-20T00:30:00Z"]) {
        const email = await render(grace, now, language);
        expect(`${email.subject} ${email.text}`).not.toMatch(/failed|declined|delivered|sent/i);
      }
    }
  });
});
