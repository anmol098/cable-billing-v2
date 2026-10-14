/**
 * The subscription state machine (pure): every transition of PLAN §13, the edge instants (IST
 * midnight, exactly at an end, 1 ms before), out-of-order and stale Razorpay reports, chained
 * transitions after a long outage, and the reminder schedule (T-7, T-1, grace start).
 */
import { describe, expect, it } from "vitest";
import { GRACE_DAYS, MONTHLY_PLAN, SUBSCRIPTION_FACTS } from "./plan";
import {
  daysUntil,
  dueNotice,
  graceEndsAt,
  istMidnightOnOrAfter,
  lastDayBefore,
  nextSubscriptionState,
  type RazorpaySnapshot,
  reactivatedNotice,
  type SubscriptionState,
} from "./state";

const at = (iso: string) => new Date(iso);
/** 00:00 IST on 13 Nov 2026: a trial that started on 13 Oct (T-027's rule). */
const TRIAL_END = at("2026-11-12T18:30:00Z");
/** 00:00 IST on 28 Nov: 15 whole days after the trial. */
const TRIAL_GRACE_END = at("2026-11-27T18:30:00Z");
const SUB = "sub_Test0001";

function state(overrides: Partial<SubscriptionState> = {}): SubscriptionState {
  return {
    status: "trialing",
    trialEndsAt: TRIAL_END,
    currentPeriodEnd: null,
    graceEndsAt: null,
    cancelledAt: null,
    razorpaySubscriptionId: null,
    razorpayStatus: null,
    razorpayStatusAt: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<RazorpaySnapshot> = {}): RazorpaySnapshot {
  return {
    subscriptionId: SUB,
    status: "active",
    currentEnd: at("2026-12-13T10:15:00Z"),
    at: at("2026-11-13T10:15:00Z"),
    ...overrides,
  };
}

describe("plan config (D-20, D-22)", () => {
  it("₹400 + 18% GST = ₹472 a month, in whole paise", () => {
    expect(MONTHLY_PLAN.pricePaise).toBe(40_000);
    expect(MONTHLY_PLAN.gstPaise).toBe(7_200);
    expect(MONTHLY_PLAN.totalPaise).toBe(47_200);
    expect(Number.isInteger(MONTHLY_PLAN.totalPaise)).toBe(true);
    expect(SUBSCRIPTION_FACTS).toMatchObject({ trialDays: 30, graceDays: 15, totalPaise: 47_200 });
    expect(GRACE_DAYS).toBe(15);
  });
});

describe("IST day helpers", () => {
  it("rounds up to the next IST midnight, but keeps an exact midnight", () => {
    expect(istMidnightOnOrAfter(TRIAL_END)).toEqual(TRIAL_END);
    expect(istMidnightOnOrAfter(at("2026-11-12T18:30:00.001Z"))).toEqual(
      at("2026-11-13T18:30:00Z"),
    );
    expect(istMidnightOnOrAfter(at("2026-11-12T18:29:59.999Z"))).toEqual(TRIAL_END);
  });

  it("grace is 15 whole IST days after the lapse, ending at an IST midnight", () => {
    expect(graceEndsAt(TRIAL_END)).toEqual(TRIAL_GRACE_END);
    // A paid month ending mid-afternoon IST on 13 Dec: the rest of that day is free on top.
    expect(graceEndsAt(at("2026-12-13T10:15:00Z"))).toEqual(at("2026-12-28T18:30:00Z"));
    expect(lastDayBefore(TRIAL_GRACE_END)).toBe("2026-11-27");
    // Never shorter than 15 × 24 h.
    for (const lapse of ["2026-11-12T18:30:00Z", "2026-11-13T18:29:59Z", "2027-02-27T05:00:00Z"]) {
      const ms = graceEndsAt(at(lapse)).getTime() - at(lapse).getTime();
      expect(ms).toBeGreaterThanOrEqual(15 * 86_400_000);
      expect(ms).toBeLessThan(16 * 86_400_000);
    }
  });

  it("counts IST calendar days", () => {
    expect(daysUntil(TRIAL_END, at("2026-11-05T18:30:00Z"))).toBe(7); // 6 Nov 00:00 IST
    expect(daysUntil(TRIAL_END, at("2026-11-06T18:29:59Z"))).toBe(7); // 6 Nov 23:59 IST
    expect(daysUntil(TRIAL_END, at("2026-11-06T18:30:00Z"))).toBe(6); // 7 Nov 00:00 IST
    expect(daysUntil(TRIAL_END, at("2026-11-12T18:29:59Z"))).toBe(1);
    expect(daysUntil(TRIAL_END, TRIAL_END)).toBe(0);
  });
});

describe("clock transitions", () => {
  it("trialing stays trialing until the exact end, then grace", () => {
    const before = nextSubscriptionState(
      state(),
      { kind: "clock" },
      at("2026-11-12T18:29:59.999Z"),
    );
    expect(before.state.status).toBe("trialing");
    expect(before.transitions).toEqual([]);
    const after = nextSubscriptionState(state(), { kind: "clock" }, TRIAL_END);
    expect(after.state).toMatchObject({ status: "grace", graceEndsAt: TRIAL_GRACE_END });
    expect(after.transitions).toEqual([{ from: "trialing", to: "grace" }]);
    expect(after.reactivated).toBe(false);
  });

  it("a cron run hours late gives the same grace end (measured from the lapse)", () => {
    const late = nextSubscriptionState(state(), { kind: "clock" }, at("2026-11-13T00:30:00Z"));
    expect(late.state.graceEndsAt).toEqual(TRIAL_GRACE_END);
  });

  it("grace → read_only exactly at grace end", () => {
    const grace = state({ status: "grace", graceEndsAt: TRIAL_GRACE_END });
    expect(
      nextSubscriptionState(grace, { kind: "clock" }, at("2026-11-27T18:29:59.999Z")).state.status,
    ).toBe("grace");
    const ro = nextSubscriptionState(grace, { kind: "clock" }, TRIAL_GRACE_END);
    expect(ro.state.status).toBe("read_only");
    expect(ro.transitions).toEqual([{ from: "grace", to: "read_only" }]);
  });

  it("a long outage chains trialing → grace → read_only in one step", () => {
    const step = nextSubscriptionState(state(), { kind: "clock" }, at("2026-12-20T00:00:00Z"));
    expect(step.state.status).toBe("read_only");
    expect(step.transitions).toEqual([
      { from: "trialing", to: "grace" },
      { from: "grace", to: "read_only" },
    ]);
  });

  it("active → grace when the paid month ends without a charge", () => {
    const cpe = at("2026-12-13T10:15:00Z");
    const active = state({ status: "active", currentPeriodEnd: cpe });
    expect(
      nextSubscriptionState(active, { kind: "clock" }, at("2026-12-13T10:14:59Z")).state.status,
    ).toBe("active");
    const step = nextSubscriptionState(active, { kind: "clock" }, cpe);
    expect(step.state).toMatchObject({ status: "grace", graceEndsAt: at("2026-12-28T18:30:00Z") });
  });

  it("active with autopay cancelled → cancelled (no grace) when the paid month ends", () => {
    const cpe = at("2026-12-13T10:15:00Z");
    const active = state({
      status: "active",
      currentPeriodEnd: cpe,
      cancelledAt: at("2026-12-01T00:00:00Z"),
    });
    const step = nextSubscriptionState(active, { kind: "clock" }, cpe);
    expect(step.state.status).toBe("cancelled");
    expect(step.transitions).toEqual([{ from: "active", to: "cancelled" }]);
  });

  it("read_only and cancelled never move by the clock", () => {
    for (const status of ["read_only", "cancelled"] as const) {
      const step = nextSubscriptionState(
        state({ status }),
        { kind: "clock" },
        at("2030-01-01T00:00:00Z"),
      );
      expect(step.state.status).toBe(status);
      expect(step.transitions).toEqual([]);
    }
  });

  it("is idempotent: applying the clock twice changes nothing more", () => {
    const once = nextSubscriptionState(state(), { kind: "clock" }, TRIAL_END);
    const twice = nextSubscriptionState(once.state, { kind: "clock" }, TRIAL_END);
    expect(twice.state).toEqual(once.state);
    expect(twice.transitions).toEqual([]);
  });
});

describe("Razorpay reports", () => {
  const withSub = (overrides: Partial<SubscriptionState> = {}) =>
    state({
      razorpaySubscriptionId: SUB,
      razorpayStatus: "created",
      razorpayStatusAt: at("2026-11-01T00:00:00Z"),
      ...overrides,
    });

  it("every state becomes active when Razorpay reports a paid month", () => {
    const now = at("2026-11-13T10:20:00Z");
    for (const status of ["trialing", "grace", "read_only", "cancelled", "active"] as const) {
      const step = nextSubscriptionState(
        withSub({
          status,
          graceEndsAt: status === "grace" ? TRIAL_GRACE_END : null,
          cancelledAt: status === "cancelled" ? now : null,
        }),
        { kind: "razorpay", snapshot: snapshot() },
        now,
      );
      expect(step.state).toMatchObject({
        status: "active",
        currentPeriodEnd: at("2026-12-13T10:15:00Z"),
        graceEndsAt: null,
        cancelledAt: null,
        razorpayStatus: "active",
      });
      expect(step.reactivated).toBe(status === "read_only" || status === "cancelled");
    }
  });

  it("a duplicate report changes nothing", () => {
    const now = at("2026-11-13T10:20:00Z");
    const once = nextSubscriptionState(withSub(), { kind: "razorpay", snapshot: snapshot() }, now);
    const twice = nextSubscriptionState(
      once.state,
      { kind: "razorpay", snapshot: snapshot() },
      now,
    );
    expect(twice.state).toEqual(once.state);
    expect(twice.transitions).toEqual([]);
  });

  it("the paid end only moves forward (a late `activated` after `charged`)", () => {
    const now = at("2026-12-14T00:00:00Z");
    const charged = snapshot({
      currentEnd: at("2027-01-13T10:15:00Z"),
      at: at("2026-12-13T10:16:00Z"),
    });
    const activated = snapshot({
      currentEnd: at("2026-12-13T10:15:00Z"),
      at: at("2026-11-13T10:15:00Z"),
    });
    const first = nextSubscriptionState(
      withSub({ status: "active", currentPeriodEnd: at("2026-12-13T10:15:00Z") }),
      { kind: "razorpay", snapshot: charged },
      now,
    );
    const late = nextSubscriptionState(first.state, { kind: "razorpay", snapshot: activated }, now);
    expect(late.state.currentPeriodEnd).toEqual(at("2027-01-13T10:15:00Z"));
    expect(late.state.razorpayStatusAt).toEqual(at("2026-12-13T10:16:00Z"));
    expect(late.ignored).toBe("older_snapshot");
  });

  it("an old charge whose month is already over does not activate", () => {
    const now = at("2027-02-01T00:00:00Z");
    const step = nextSubscriptionState(
      withSub({ status: "read_only" }),
      { kind: "razorpay", snapshot: snapshot({ currentEnd: at("2027-01-13T10:15:00Z") }) },
      now,
    );
    expect(step.state.status).toBe("read_only");
  });

  it("reports about another subscription are ignored", () => {
    const step = nextSubscriptionState(
      withSub({ status: "grace", graceEndsAt: TRIAL_GRACE_END }),
      { kind: "razorpay", snapshot: snapshot({ subscriptionId: "sub_Old0001" }) },
      at("2026-11-20T00:00:00Z"),
    );
    expect(step.ignored).toBe("not_current_subscription");
    expect(step.state.status).toBe("grace");
    expect(step.state.razorpayStatus).toBe("created");
  });

  it("authenticated (autopay set during the trial) keeps the trial", () => {
    const step = nextSubscriptionState(
      withSub(),
      { kind: "razorpay", snapshot: snapshot({ status: "authenticated", currentEnd: null }) },
      at("2026-11-02T00:00:00Z"),
    );
    expect(step.state).toMatchObject({ status: "trialing", razorpayStatus: "authenticated" });
  });

  it("pending/halted before the paid end change nothing; after it the tenant is in grace", () => {
    const active = withSub({
      status: "active",
      currentPeriodEnd: at("2026-12-13T10:15:00Z"),
      razorpayStatus: "active",
    });
    const early = nextSubscriptionState(
      active,
      {
        kind: "razorpay",
        snapshot: snapshot({ status: "pending", at: at("2026-12-10T00:00:00Z") }),
      },
      at("2026-12-10T00:00:00Z"),
    );
    expect(early.state.status).toBe("active");
    for (const status of ["pending", "halted"] as const) {
      const late = nextSubscriptionState(
        active,
        { kind: "razorpay", snapshot: snapshot({ status, at: at("2026-12-13T11:00:00Z") }) },
        at("2026-12-13T11:00:00Z"),
      );
      expect(late.state).toMatchObject({
        status: "grace",
        graceEndsAt: at("2026-12-28T18:30:00Z"),
        razorpayStatus: status,
      });
    }
  });

  it("cancelled: paid time is honoured, then cancelled; grace/read_only → cancelled at once; trial unchanged", () => {
    const now = at("2026-12-01T00:00:00Z");
    const cancel = snapshot({ status: "cancelled", at: now });
    const active = nextSubscriptionState(
      withSub({ status: "active", currentPeriodEnd: at("2026-12-13T10:15:00Z") }),
      { kind: "razorpay", snapshot: cancel },
      now,
    );
    expect(active.state).toMatchObject({ status: "active", cancelledAt: now });
    expect(
      nextSubscriptionState(active.state, { kind: "clock" }, at("2026-12-13T10:15:00Z")).state
        .status,
    ).toBe("cancelled");
    for (const status of ["grace", "read_only"] as const) {
      const step = nextSubscriptionState(
        withSub({ status, graceEndsAt: at("2026-12-05T18:30:00Z") }),
        { kind: "razorpay", snapshot: cancel },
        now,
      );
      expect(step.state.status).toBe("cancelled");
    }
    const trial = nextSubscriptionState(
      withSub({ trialEndsAt: at("2026-12-10T18:30:00Z") }),
      { kind: "razorpay", snapshot: cancel },
      now,
    );
    expect(trial.state.status).toBe("trialing");
    // The trial still ends into grace (the Owner can pay again).
    expect(
      nextSubscriptionState(trial.state, { kind: "clock" }, at("2026-12-10T18:30:00Z")).state
        .status,
    ).toBe("grace");
  });

  it("a new checkout replaces the subscription and clears a cancellation", () => {
    const step = nextSubscriptionState(
      withSub({
        status: "active",
        currentPeriodEnd: at("2026-12-13T10:15:00Z"),
        cancelledAt: at("2026-12-01T00:00:00Z"),
        razorpayStatus: "cancelled",
      }),
      { kind: "checkout_created", subscriptionId: "sub_New0001" },
      at("2026-12-02T00:00:00Z"),
    );
    expect(step.state).toMatchObject({
      status: "active",
      razorpaySubscriptionId: "sub_New0001",
      razorpayStatus: "created",
      cancelledAt: null,
    });
    // At the paid end without a charge: grace (not cancelled).
    expect(
      nextSubscriptionState(step.state, { kind: "clock" }, at("2026-12-13T10:15:00Z")).state.status,
    ).toBe("grace");
  });

  it("the admin's manual extension activates until a future date only", () => {
    const now = at("2027-01-05T00:00:00Z");
    const ro = state({ status: "read_only" });
    const step = nextSubscriptionState(
      ro,
      { kind: "manual_extend", until: at("2027-02-05T18:30:00Z") },
      now,
    );
    expect(step.state).toMatchObject({
      status: "active",
      currentPeriodEnd: at("2027-02-05T18:30:00Z"),
    });
    expect(step.reactivated).toBe(true);
    const past = nextSubscriptionState(
      ro,
      { kind: "manual_extend", until: at("2027-01-01T00:00:00Z") },
      now,
    );
    expect(past.ignored).toBe("until_in_past");
    expect(past.state.status).toBe("read_only");
  });
});

describe("reminders (T-7, T-1, grace start)", () => {
  it("trial: nothing until 7 days left, then T-7, then T-1, nothing on the end day", () => {
    const s = state();
    expect(dueNotice(s, at("2026-11-05T18:29:59Z"))).toBeNull(); // 8 days left
    expect(dueNotice(s, at("2026-11-05T18:30:00Z"))).toMatchObject({
      kind: "trial_ending",
      key: "trial_ending:7:2026-11-13",
      lastDay: "2026-11-12",
      daysLeft: 7,
    });
    // A missed cron day still sends the T-7 (window), keyed the same.
    expect(dueNotice(s, at("2026-11-07T01:00:00Z"))?.key).toBe("trial_ending:7:2026-11-13");
    expect(dueNotice(s, at("2026-11-11T18:30:00Z"))).toMatchObject({
      key: "trial_ending:1:2026-11-13",
      daysLeft: 1,
    });
    expect(dueNotice(s, TRIAL_END)).toBeNull();
  });

  it("no trial reminders when autopay is already set up", () => {
    const s = state({ razorpaySubscriptionId: SUB, razorpayStatus: "authenticated" });
    expect(dueNotice(s, at("2026-11-11T18:30:00Z"))).toBeNull();
    const notFinished = state({ razorpaySubscriptionId: SUB, razorpayStatus: "created" });
    expect(dueNotice(notFinished, at("2026-11-11T18:30:00Z"))?.kind).toBe("trial_ending");
  });

  it("grace: started (once per grace), then T-7 and T-1 before view-only", () => {
    const g = state({ status: "grace", graceEndsAt: TRIAL_GRACE_END });
    expect(dueNotice(g, TRIAL_END)).toMatchObject({
      kind: "grace_started",
      key: "grace_started:0:2026-11-28",
      lastDay: "2026-11-27",
      daysLeft: 15,
    });
    expect(dueNotice(g, at("2026-11-20T18:30:00Z"))).toMatchObject({
      key: "grace_ending:7:2026-11-28",
    });
    expect(dueNotice(g, at("2026-11-26T18:30:00Z"))).toMatchObject({
      key: "grace_ending:1:2026-11-28",
    });
  });

  it("nothing for active, read_only or cancelled tenants", () => {
    for (const status of ["active", "read_only", "cancelled"] as const) {
      expect(
        dueNotice(
          state({ status, currentPeriodEnd: at("2026-11-14T00:00:00Z") }),
          at("2026-11-13T00:00:00Z"),
        ),
      ).toBeNull();
    }
  });

  it("reactivation notice names the paid-till day", () => {
    const n = reactivatedNotice(
      state({ status: "active", currentPeriodEnd: at("2026-12-13T10:15:00Z") }),
      at("2026-11-13T10:20:00Z"),
    );
    expect(n).toMatchObject({ kind: "reactivated", lastDay: "2026-12-13" });
  });
});
