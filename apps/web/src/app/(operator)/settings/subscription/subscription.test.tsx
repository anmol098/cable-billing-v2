/**
 * Settings → App subscription (T-085): what the Owner sees in every state (EN + HI), the Pay
 * button's Razorpay Checkout flow with a fake Checkout (start → open → handler → confirm; closed;
 * errors; autopay already on), and the shell's trial-ending banner.
 */
import { MONTHLY_PLAN, type SubscriptionView, subscriptionViewOf } from "@cb/core";
import { ToastProvider } from "@cb/ui";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bannerFor, SubscriptionBanner } from "@/components/shell/subscription-banner";
import { renderWithIntl } from "@/test/intl";
import type { ConfirmCheckoutState, StartCheckoutState } from "./actions";
import { PayButton } from "./pay-button";
import { SubscriptionPage } from "./subscription-view";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => "/settings/subscription",
}));

const OP = "0192f3a0-0000-7000-8000-000000000001";
const TRIAL_END = new Date("2026-11-12T18:30:00Z"); // 00:00 IST 13 Nov → free till 12 Nov

function view(overrides: Partial<SubscriptionView>): SubscriptionView {
  return {
    ...subscriptionViewOf(
      OP,
      {
        status: "trialing",
        trialEndsAt: TRIAL_END,
        currentPeriodEnd: null,
        graceEndsAt: null,
        cancelledAt: null,
        razorpaySubscriptionId: null,
        razorpayStatus: null,
        razorpayStatusAt: null,
        planCode: MONTHLY_PLAN.code,
      },
      [],
    ),
    ...overrides,
  };
}

const neverStart = vi.fn(async (): Promise<StartCheckoutState> => ({ kind: "autopay_on" }));
const neverConfirm = vi.fn(async (): Promise<ConfirmCheckoutState> => ({ kind: "waiting" }));

function page(v: SubscriptionView, options: { locale?: "en" | "hi"; ready?: boolean } = {}) {
  const locale = options.locale ?? "en";
  return renderWithIntl(
    <ToastProvider closeLabel="Close" label="Notifications">
      <SubscriptionPage
        title="App subscription"
        view={v}
        locale={locale}
        paymentReady={options.ready ?? true}
        start={neverStart}
        confirm={neverConfirm}
      />
    </ToastProvider>,
    locale,
  );
}

afterEach(() => {
  delete window.Razorpay;
  vi.clearAllMocks();
});

describe("subscription page", () => {
  it("trial: free till the last day, the price with GST, Pay ₹472 a month, nothing taken today", () => {
    page(view({}));
    const status = within(
      screen.getByText("Free trial").closest("[data-subscription='status']") as HTMLElement,
    );
    expect(status.getByText("Free till 12 Nov 2026.")).toBeInTheDocument();
    expect(screen.getByText("₹472 a month")).toBeInTheDocument();
    expect(screen.getByText("₹400 + ₹72 GST (18%)")).toBeInTheDocument();
    expect(screen.getByText("Any number of customers.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pay ₹472 a month" })).toBeInTheDocument();
    expect(
      screen.getByText("Nothing is taken today. The first payment is on 13 Nov 2026."),
    ).toBeInTheDocument();
  });

  it("paid with autopay on: no Pay button", () => {
    page(
      view({
        status: "active",
        currentPeriodEnd: new Date("2026-12-13T04:05:00Z"),
        accessLastDay: "2026-12-13" as SubscriptionView["accessLastDay"],
        autopay: "on",
        razorpayStatus: "active",
        canPay: false,
      }),
    );
    expect(screen.getByText("Paid")).toBeInTheDocument();
    expect(screen.getByText("Paid till 13 Dec 2026.")).toBeInTheDocument();
    expect(
      screen.getByText("Autopay is on. Razorpay takes ₹472 every month by itself."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pay/ })).toBeNull();
  });

  it("grace, view only, stopped: say what still works; Pay is offered", () => {
    const { unmount } = page(
      view({
        status: "grace",
        graceEndsAt: new Date("2026-11-27T18:30:00Z"),
        accessLastDay: "2026-11-27" as SubscriptionView["accessLastDay"],
        autopay: "failing",
      }),
    );
    expect(
      screen.getByText("Pay by 27 Nov 2026. After that you can only look and collect money."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("This month's autopay payment has not reached us. Please pay again."),
    ).toBeInTheDocument();
    unmount();
    const ro = page(view({ status: "read_only", mode: "read_only", accessLastDay: null }));
    expect(screen.getByText("View only")).toBeInTheDocument();
    expect(
      screen.getByText("You can look and collect money. Pay to make bills and changes again."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pay ₹472 a month" })).toBeInTheDocument();
    ro.unmount();
    page(view({ status: "cancelled", mode: "read_only", accessLastDay: null }));
    expect(screen.getByText("Stopped")).toBeInTheDocument();
  });

  it("after paying again: the missed bill months, with a link to Bills (D-25)", () => {
    page(
      view({
        status: "active",
        mode: "normal",
        accessLastDay: "2026-12-28" as SubscriptionView["accessLastDay"],
        autopay: "on",
        canPay: false,
        missedRunPeriods: ["2026-10-01", "2026-11-01"],
      }),
    );
    const missed = within(
      screen.getByText("Missed bill runs").closest("[data-subscription='missed']") as HTMLElement,
    );
    expect(missed.getByText(/October 2026, November 2026/)).toBeInTheDocument();
    expect(missed.getByRole("link", { name: "Open bills" })).toHaveAttribute("href", "/bills/runs");
  });

  it("without Razorpay keys (H-01) says so honestly instead of a button", () => {
    page(view({}), { ready: false });
    expect(
      screen.getByText("Online payment is not set up yet. Please call support."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pay/ })).toBeNull();
  });

  it("Hindi", () => {
    page(view({}), { locale: "hi" });
    expect(screen.getByText("फ़्री ट्रायल")).toBeInTheDocument();
    expect(screen.getByText("12 नव 2026 तक मुफ़्त।")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "₹472 महीना पेमेंट करें" })).toBeInTheDocument();
  });
});

describe("Pay button (Razorpay Checkout, faked)", () => {
  type Options = {
    key: string;
    subscription_id: string;
    handler: (r: Record<string, string>) => void;
    modal: { ondismiss: () => void };
  };
  function fakeCheckout() {
    const opened: Options[] = [];
    window.Razorpay = class {
      constructor(readonly options: Options) {
        opened.push(options);
      }
      open() {}
    } as unknown as NonNullable<Window["Razorpay"]>;
    return opened;
  }

  function button(
    start: () => Promise<StartCheckoutState>,
    confirm: (r: unknown) => Promise<ConfirmCheckoutState>,
  ) {
    renderWithIntl(
      <ToastProvider closeLabel="Close" label="Notifications">
        <PayButton totalText="₹472" locale="en" start={start} confirm={confirm} />
      </ToastProvider>,
    );
    return screen.getByRole("button", { name: "Pay ₹472 a month" });
  }

  it("opens Checkout with the subscription, then confirms Razorpay's answer on the server", async () => {
    const opened = fakeCheckout();
    const start = vi.fn(
      async (): Promise<StartCheckoutState> => ({
        kind: "open",
        keyId: "rzp_test_Fake123",
        subscriptionId: "sub_Test0001",
        firstChargeAt: null,
      }),
    );
    const confirm = vi.fn(
      async (): Promise<ConfirmCheckoutState> => ({ kind: "paid", paidTill: "2026-12-01" }),
    );
    const pay = button(start, confirm);
    await act(async () => fireEvent.click(pay));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ key: "rzp_test_Fake123", subscription_id: "sub_Test0001" });
    await act(async () =>
      opened[0]?.handler({
        razorpay_payment_id: "pay_Test01",
        razorpay_subscription_id: "sub_Test0001",
        razorpay_signature: "f".repeat(64),
      }),
    );
    expect(confirm).toHaveBeenCalledWith({
      paymentId: "pay_Test01",
      subscriptionId: "sub_Test0001",
      signature: "f".repeat(64),
    });
    expect(await screen.findByText("Thank you. Paid till 1 Dec 2026.")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it("closing Checkout says the payment was not finished; errors are in words", async () => {
    const opened = fakeCheckout();
    const start = vi.fn(
      async (): Promise<StartCheckoutState> => ({
        kind: "open",
        keyId: "rzp_test_Fake123",
        subscriptionId: "sub_Test0002",
        firstChargeAt: null,
      }),
    );
    const pay = button(start, neverConfirm);
    await act(async () => fireEvent.click(pay));
    await act(async () => opened[0]?.modal.ondismiss());
    expect(screen.getByText("Payment was not finished.")).toBeInTheDocument();
    start.mockResolvedValueOnce({ kind: "error", reason: "provider" });
    await act(async () => fireEvent.click(pay));
    expect(
      screen.getByText("Razorpay is not answering. Please try again in a few minutes."),
    ).toBeInTheDocument();
    start.mockResolvedValueOnce({ kind: "error", reason: "plan_mismatch" });
    await act(async () => fireEvent.click(pay));
    expect(
      screen.getByText("Online payment is not set up right. Please call support."),
    ).toBeInTheDocument();
    start.mockResolvedValueOnce({ kind: "autopay_on" });
    await act(async () => fireEvent.click(pay));
    expect(screen.getByText("Autopay is already on. Nothing to pay now.")).toBeInTheDocument();
  });

  it("the server not seeing the payment yet is said honestly (no 'paid')", async () => {
    const opened = fakeCheckout();
    const start = vi.fn(
      async (): Promise<StartCheckoutState> => ({
        kind: "open",
        keyId: "rzp_test_Fake123",
        subscriptionId: "sub_Test0003",
        firstChargeAt: null,
      }),
    );
    const pay = button(start, neverConfirm);
    await act(async () => fireEvent.click(pay));
    await act(async () => opened[0]?.handler({}));
    expect(
      await screen.findByText(
        "Razorpay has not confirmed the payment yet. This page will show it soon.",
      ),
    ).toBeInTheDocument();
  });
});

describe("trial-ending banner (shell)", () => {
  const now = (iso: string) => new Date(iso);
  it("Owner only, 7 days or less before the trial ends, not with autopay", () => {
    const input = { status: "trialing" as const, graceEndsAt: null, trialEndsAt: TRIAL_END };
    expect(bannerFor(input, true, now("2026-11-05T18:29:00Z"))).toBeNull(); // 8 days
    expect(bannerFor(input, true, now("2026-11-05T18:30:00Z"))).toEqual({
      kind: "trial_ending",
      trialEndsAt: TRIAL_END,
      canPay: true,
    });
    expect(bannerFor(input, false, now("2026-11-10T00:00:00Z"))).toBeNull();
    expect(bannerFor({ ...input, autopayOn: true }, true, now("2026-11-10T00:00:00Z"))).toBeNull();
    expect(bannerFor(input, true, TRIAL_END)).toBeNull();
  });

  it("names the last free day", () => {
    renderWithIntl(
      <SubscriptionBanner
        banner={{ kind: "trial_ending", trialEndsAt: TRIAL_END, canPay: true }}
        locale="en"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Free trial ends on 12 Nov 2026. Pay to keep using the app.",
    );
    expect(screen.getByRole("link", { name: "Pay now" })).toHaveAttribute(
      "href",
      "/settings/subscription",
    );
  });
});
