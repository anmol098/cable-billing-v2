"use client";

/**
 * "Pay ₹472 a month" (T-085): asks the server for a Razorpay subscription, opens Razorpay Checkout
 * (UPI Autopay or card mandate) in the page, and on success asks the server to confirm it with
 * Razorpay. Checkout's script is loaded only when the Owner presses the button. The browser never
 * decides the state: the server verifies Razorpay's signature and reads Razorpay's API.
 */
import { type BusinessDate, type DisplayLocale, formatBusinessDate } from "@cb/domain";
import { Button, useToast } from "@cb/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Notice } from "../profile/field";
import type { CheckoutFailure, ConfirmCheckoutState, StartCheckoutState } from "./actions";

/** Razorpay's documented Checkout script. */
export const RAZORPAY_CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

/** The fields Checkout passes to `handler` for a subscription. */
export interface RazorpayCheckoutResponse {
  razorpay_payment_id?: string;
  razorpay_subscription_id?: string;
  razorpay_signature?: string;
}

interface RazorpayCheckoutOptions {
  key: string;
  subscription_id: string;
  name: string;
  description: string;
  handler: (response: RazorpayCheckoutResponse) => void;
  modal: { ondismiss: () => void };
}

type RazorpayCheckout = new (
  options: RazorpayCheckoutOptions,
) => { open(): void; on?(event: string, callback: (response: unknown) => void): void };

declare global {
  interface Window {
    Razorpay?: RazorpayCheckout;
  }
}

let loading: Promise<RazorpayCheckout | null> | null = null;

/** Loads Checkout once per page; `null` if it can't load (offline, blocked). */
export function loadRazorpayCheckout(): Promise<RazorpayCheckout | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  loading ??= new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = RAZORPAY_CHECKOUT_SRC;
    script.async = true;
    script.onload = () => resolve(window.Razorpay ?? null);
    script.onerror = () => {
      loading = null;
      resolve(null);
    };
    document.head.appendChild(script);
  });
  return loading;
}

type Message = { tone: "success" | "pending" | "danger"; text: string } | null;

export function PayButton({
  totalText,
  locale,
  start,
  confirm,
}: {
  /** `"₹472"`. */
  totalText: string;
  locale: DisplayLocale;
  start: () => Promise<StartCheckoutState>;
  confirm: (response: {
    paymentId: unknown;
    subscriptionId: unknown;
    signature: unknown;
  }) => Promise<ConfirmCheckoutState>;
}) {
  const t = useTranslations("subscription");
  const router = useRouter();
  const [busy, setBusy] = useState<"opening" | "checking" | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const { toast } = useToast();
  /** Success goes to a toast: it outlives this button (the page hides it once autopay is on). */
  const show = (next: Message) => {
    if (next?.tone === "success") {
      toast({ variant: "success", title: next.text });
      setMessage(null);
    } else setMessage(next);
  };
  const day = (date: string | null) =>
    date ? formatBusinessDate(date as BusinessDate, locale) : "";

  const failure = (reason: CheckoutFailure): Message => ({
    tone: "danger",
    text:
      reason === "not_set_up"
        ? t("not_set_up")
        : reason === "provider"
          ? t("error.provider")
          : reason === "plan_mismatch"
            ? t("error.plan_mismatch")
            : t("error.unexpected"),
  });

  async function onConfirm(response: RazorpayCheckoutResponse) {
    setBusy("checking");
    try {
      const result = await confirm({
        paymentId: response.razorpay_payment_id,
        subscriptionId: response.razorpay_subscription_id,
        signature: response.razorpay_signature,
      });
      if (result.kind === "error") setMessage(failure(result.reason));
      else if (result.kind === "paid") {
        show({ tone: "success", text: t("result.paid", { date: day(result.paidTill) }) });
      } else if (result.kind === "autopay_set") {
        show({ tone: "success", text: t("autopay.on_first", { date: day(result.firstChargeOn) }) });
      } else setMessage({ tone: "pending", text: t("result.waiting") });
      router.refresh();
    } catch {
      setMessage(failure("unexpected"));
    } finally {
      setBusy(null);
    }
  }

  async function onPay() {
    setMessage(null);
    setBusy("opening");
    try {
      const started = await start();
      if (started.kind === "error") {
        setMessage(failure(started.reason));
        setBusy(null);
        return;
      }
      if (started.kind === "autopay_on") {
        show({ tone: "success", text: t("result.autopay_on") });
        setBusy(null);
        router.refresh();
        return;
      }
      const Checkout = await loadRazorpayCheckout();
      if (!Checkout) {
        setMessage(failure("provider"));
        setBusy(null);
        return;
      }
      const checkout = new Checkout({
        key: started.keyId,
        subscription_id: started.subscriptionId,
        name: t("checkout_name"),
        description: t("checkout_description", { total: totalText }),
        handler: (response) => {
          void onConfirm(response);
        },
        modal: {
          ondismiss: () => {
            setBusy(null);
            setMessage({ tone: "pending", text: t("result.closed") });
          },
        },
      });
      checkout.open();
    } catch {
      setMessage(failure("unexpected"));
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3" data-subscription="pay">
      <Button
        type="button"
        size="lg"
        icon="subscription"
        loading={busy !== null}
        loadingLabel={busy === "checking" ? t("checking") : t("opening")}
        onClick={() => void onPay()}
      >
        {t("pay", { total: totalText })}
      </Button>
      {message ? (
        message.tone === "success" ? (
          <p role="status" className="font-strong text-base text-success">
            {message.text}
          </p>
        ) : (
          <Notice tone={message.tone}>{message.text}</Notice>
        )
      ) : null}
    </div>
  );
}
