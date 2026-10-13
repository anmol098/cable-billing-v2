"use client";

/**
 * The office counter payment (T-048, PLAN §12.1 "Take payment", FR-013): four steps, one job each
 * (PLAN §2.2), as few taps as possible:
 *
 * 1. **Who is paying?** search (name, mobile no., code, VC number) → tap the customer;
 * 2. **How much money?** pre-filled with the full due → Next;
 * 3. **How did they pay?** Cash (→ step 4) or UPI (+ optional UPI ref no. → Next);
 * 4. **Check and save** → Save → "Money saved" with the receipt actions (print A5, copy link).
 *
 * **One payment per form, whatever happens:** the payment id (UUIDv7, the server's idempotency
 * key, FR-015) is made in the browser on the first Save and reused for every later Save of the
 * same form (a double click, a retry after "Could not save"). The server posts it once; the
 * same id again is a `duplicate` with the same receipt. A new id is made only for "Take another
 * payment". Save is also locked while a save is running.
 */
import {
  Amount,
  AmountInput,
  type AmountInputRejectReason,
  Button,
  Card,
  Combobox,
  type ComboboxOption,
  Icon,
  Input,
  StatusPill,
} from "@cb/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { balanceText, newPaymentId, paymentHref, rupees, type Translate } from "./format";
import { ReceiptActions } from "./receipt-actions";
import type {
  FindCustomersResult,
  PickerCustomer,
  ReceiptLinkResult,
  SavedPayment,
  TakePaymentErrorKey,
  TakePaymentInput,
  TakePaymentResult,
} from "./results";

/** Largest counter amount (paise): ₹10,00,000 (the core limit is far higher). */
export const COUNTER_MAX_PAISE = 100_000_000;
const MAX_UPI_REF = 64;

type Step = "customer" | "amount" | "method" | "confirm" | "saved";

export interface CounterPaymentProps {
  /** The customer chosen before the page opened (`?customer=` from "Take payment"). */
  readonly initialCustomer?: PickerCustomer | null;
  readonly findCustomers: (query: string) => Promise<FindCustomersResult>;
  readonly takePayment: (input: TakePaymentInput) => Promise<TakePaymentResult>;
  readonly copyReceiptLink: (paymentId: string) => Promise<ReceiptLinkResult>;
  /** Makes the payment id (tests inject a fixed one). */
  readonly makeId?: () => string;
}

const STEP_NUMBER: Record<Exclude<Step, "saved">, number> = {
  customer: 1,
  amount: 2,
  method: 3,
  confirm: 4,
};

function prefill(customer: PickerCustomer | null | undefined): number | null {
  return customer && customer.balancePaise > 0 ? customer.balancePaise : null;
}

export function CounterPayment({
  initialCustomer = null,
  findCustomers,
  takePayment,
  copyReceiptLink,
  makeId = newPaymentId,
}: CounterPaymentProps) {
  const t = useTranslations("payments");
  const words = t as unknown as Translate;
  const amountId = useId();
  const upiId = useId();

  const [step, setStep] = useState<Step>(initialCustomer ? "amount" : "customer");
  const [customer, setCustomer] = useState<PickerCustomer | null>(initialCustomer);
  const [amount, setAmount] = useState<number | null>(prefill(initialCustomer));
  const [amountProblem, setAmountProblem] = useState<string | null>(null);
  const [method, setMethod] = useState<"cash" | "upi" | null>(null);
  const [upiRef, setUpiRef] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<TakePaymentErrorKey | null>(null);
  const [saved, setSaved] = useState<SavedPayment | null>(null);

  /** The form's payment id: made on the first Save, kept until "Take another payment". */
  const paymentId = useRef<string | null>(null);
  /** Locks Save while a save runs (a second click before React re-renders does nothing). */
  const inFlight = useRef(false);
  /** The last search's customers, by id (the picker only hands back the option). */
  const found = useRef(new Map<string, PickerCustomer>());

  const loadOptions = async (query: string): Promise<readonly ComboboxOption[]> => {
    const result = await findCustomers(query);
    if (!result.ok) throw new Error("search failed");
    found.current = new Map(result.customers.map((c) => [c.id, c]));
    return result.customers.map((c) => ({
      value: c.id,
      label: c.name,
      description: [
        t("new.confirm_code", { code: c.code }),
        c.phone,
        c.areaName,
        c.active ? null : t("new.closed"),
        balanceText(words, c.balancePaise),
      ]
        .filter(Boolean)
        .join(" · "),
    }));
  };

  const choose = (option: ComboboxOption) => {
    const picked = found.current.get(option.value);
    if (!picked) return;
    setCustomer(picked);
    setAmount(prefill(picked));
    setAmountProblem(null);
    setError(null);
    setStep("amount");
  };

  const rejectText = (reason: AmountInputRejectReason) =>
    reason === "too-large" ? t("new.amount_too_large") : t("new.amount_whole");

  const amountNext = () => {
    if (amount === null || amount <= 0) {
      setAmountProblem(t("new.amount_required"));
      return;
    }
    setAmountProblem(null);
    setStep("method");
  };

  const pickMethod = (value: "cash" | "upi") => {
    setMethod(value);
    setError(null);
    if (value === "cash") setStep("confirm");
  };

  const save = async () => {
    if (inFlight.current || !customer || amount === null || !method) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    paymentId.current ??= makeId();
    const ref = upiRef.trim();
    let result: TakePaymentResult;
    try {
      result = await takePayment({
        id: paymentId.current,
        customerId: customer.id,
        amountPaise: amount,
        method,
        ...(method === "upi" && ref ? { upiReference: ref } : {}),
      });
    } catch {
      result = { ok: false, error: "generic" };
    }
    if (result.ok) {
      setSaved(result.payment);
      setStep("saved");
    } else {
      setError(result.error);
    }
    setSaving(false);
    inFlight.current = false;
  };

  const startAgain = () => {
    paymentId.current = null;
    found.current = new Map();
    setCustomer(null);
    setAmount(null);
    setAmountProblem(null);
    setMethod(null);
    setUpiRef("");
    setError(null);
    setSaved(null);
    setStep("customer");
  };

  const methodWord = (value: "cash" | "upi") => t(`method.${value}`);

  // --- Saved ------------------------------------------------------------------------------------
  if (step === "saved" && saved && customer) {
    return (
      <section className="flex flex-col gap-6" aria-labelledby="counter-saved" data-step="saved">
        <Card className="flex flex-col gap-4 p-4 sm:p-6">
          <h2
            id="counter-saved"
            className="flex items-center gap-2 font-strong text-2xl text-success"
          >
            <Icon name="success" className="size-8 shrink-0" />
            {t("new.saved_title")}
          </h2>
          <Amount
            paise={saved.amountPaise}
            size="amount"
            weight="strong"
            data-testid="saved-amount"
          />
          <p className="text-lg text-text">
            {t("new.saved_summary", {
              amount: rupees(saved.amountPaise),
              method: methodWord(saved.method),
              name: customer.name,
            })}
          </p>
          <dl className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-text-muted">{t("new.receipt_number")}</dt>
              <dd className="font-numeric text-xl" data-testid="saved-receipt">
                {saved.receiptNumber}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-text-muted">{t("new.balance_now")}</dt>
              <dd className="text-xl" data-testid="saved-balance">
                {balanceText(words, saved.newBalancePaise)}
              </dd>
            </div>
          </dl>
          {saved.reviewReason ? (
            <p className="flex items-start gap-2 text-base text-pending">
              <Icon name="pending" className="mt-1 shrink-0" />
              {t("new.saved_flagged", { reason: t(`review_reason.${saved.reviewReason}`) })}
            </p>
          ) : null}
          {saved.cancelled ? <StatusPill variant="danger" label={t("status.cancelled")} /> : null}
        </Card>
        <ReceiptActions paymentId={saved.paymentId} copyLink={copyReceiptLink} />
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button size="lg" icon="add" onClick={startAgain}>
            {t("new.another")}
          </Button>
          <Button asChild variant="quiet" size="lg" icon="next">
            <Link href={paymentHref(saved.paymentId)}>{t("new.open_payment")}</Link>
          </Button>
        </div>
      </section>
    );
  }

  const number = STEP_NUMBER[step === "saved" ? "confirm" : step];

  return (
    <section className="flex flex-col gap-6" data-step={step}>
      <p className="font-numeric text-base text-text-muted" aria-live="polite">
        {t("new.step", { step: number })}
      </p>

      {customer && step !== "customer" ? (
        <Card className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            <span
              className="flex items-center gap-2 font-strong text-lg"
              data-testid="chosen-customer"
            >
              <Icon name="customer" className="shrink-0" />
              {customer.name}
            </span>
            <span className="text-sm text-text-muted">
              {t("new.confirm_code", { code: customer.code })}
            </span>
          </div>
          <Button variant="quiet" icon="edit" onClick={() => setStep("customer")} disabled={saving}>
            {t("new.change_customer")}
          </Button>
        </Card>
      ) : null}

      {step === "customer" ? (
        <div className="flex flex-col gap-4">
          <h2 className="font-strong text-xl">{t("new.find_title")}</h2>
          <Combobox
            label={t("new.find_label")}
            placeholder={t("new.find_placeholder")}
            loadOptions={loadOptions}
            onSelect={choose}
            loadingLabel={t("new.searching")}
            emptyLabel={t("new.no_match")}
            errorLabel={t("new.search_failed")}
            resultsLabel={(count) => t("new.results", { count })}
          />
        </div>
      ) : null}

      {step === "amount" && customer ? (
        <div className="flex flex-col gap-4">
          <h2 className="font-strong text-xl">{t("new.amount_title")}</h2>
          <p className="flex flex-wrap items-baseline gap-2 text-base text-text-muted">
            {customer.balancePaise > 0
              ? t("new.due_now")
              : customer.balancePaise < 0
                ? t("new.credit_now")
                : t("new.nothing_due")}
            {customer.balancePaise !== 0 ? (
              <Amount
                paise={customer.balancePaise}
                tone="balance"
                size="2xl"
                weight="strong"
                data-testid="due-now"
              />
            ) : null}
          </p>
          {customer.active ? null : (
            <p className="flex items-start gap-2 text-base text-pending">
              <Icon name="pending" className="mt-1 shrink-0" />
              {t("new.closed_note")}
            </p>
          )}
          <label htmlFor={amountId} className="text-base text-text">
            {t("new.amount_label")}
          </label>
          <AmountInput
            id={amountId}
            value={amount}
            maxPaise={COUNTER_MAX_PAISE}
            invalid={amountProblem !== null}
            aria-describedby={amountProblem ? `${amountId}-problem` : undefined}
            onValueChange={(value) => {
              setAmount(value);
              setAmountProblem(null);
            }}
            onReject={(reason) => setAmountProblem(rejectText(reason))}
            onKeyDown={(event) => {
              if (event.key === "Enter") amountNext();
            }}
            className="max-w-sm"
          />
          {amountProblem ? (
            <p id={`${amountId}-problem`} className="text-base text-danger">
              {amountProblem}
            </p>
          ) : null}
          {customer.balancePaise > 0 && amount !== customer.balancePaise ? (
            <div>
              <Button variant="secondary" onClick={() => setAmount(customer.balancePaise)}>
                {t("new.full_due", { amount: rupees(customer.balancePaise) })}
              </Button>
            </div>
          ) : null}
          <div className="flex gap-3">
            <Button size="lg" icon="next" onClick={amountNext}>
              {t("new.next")}
            </Button>
          </div>
        </div>
      ) : null}

      {step === "method" ? (
        <div className="flex flex-col gap-4">
          <h2 className="font-strong text-xl">{t("new.method_title")}</h2>
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="sr-only">{t("new.method_label")}</legend>
            {(["cash", "upi"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={method === value}
                onClick={() => pickMethod(value)}
                className={
                  value === "cash"
                    ? "flex min-h-touch-min items-center gap-3 rounded-lg border-strong border-cash bg-bg p-4 font-strong text-xl text-cash aria-pressed:bg-surface"
                    : "flex min-h-touch-min items-center gap-3 rounded-lg border-strong border-upi bg-bg p-4 font-strong text-xl text-upi aria-pressed:bg-surface"
                }
              >
                <Icon name={value} className="size-8 shrink-0" />
                {methodWord(value)}
              </button>
            ))}
          </fieldset>
          {method === "upi" ? (
            <div className="flex flex-col gap-2">
              <label htmlFor={upiId} className="text-base text-text">
                {t("new.upi_ref_label")}
              </label>
              <Input
                id={upiId}
                value={upiRef}
                maxLength={MAX_UPI_REF}
                autoComplete="off"
                inputMode="text"
                className="max-w-sm font-numeric"
                aria-describedby={`${upiId}-help`}
                onChange={(event) => setUpiRef(event.target.value)}
              />
              <p id={`${upiId}-help`} className="text-sm text-text-muted">
                {t("new.upi_ref_help")}
              </p>
              <div>
                <Button size="lg" icon="next" onClick={() => setStep("confirm")}>
                  {t("new.next")}
                </Button>
              </div>
            </div>
          ) : null}
          <div>
            <Button variant="quiet" icon="back" onClick={() => setStep("amount")}>
              {t("new.back")}
            </Button>
          </div>
        </div>
      ) : null}

      {step === "confirm" && customer && amount !== null && method ? (
        <div className="flex flex-col gap-4">
          <h2 className="font-strong text-xl">{t("new.confirm_title")}</h2>
          <Card className="flex flex-col gap-3 p-4 sm:p-6">
            <Amount paise={amount} size="amount" weight="strong" data-testid="confirm-amount" />
            <StatusPill variant={method} label={methodWord(method)} />
            <p className="text-lg" data-testid="confirm-summary">
              {t("new.confirm_summary", {
                amount: rupees(amount),
                method: methodWord(method),
                name: customer.name,
              })}
            </p>
            {method === "upi" && upiRef.trim() ? (
              <p className="text-base text-text-muted">
                {t("detail.upi_ref")}: <span className="font-numeric">{upiRef.trim()}</span>
              </p>
            ) : null}
            <p className="text-base text-text">
              {t("new.due_after", { balance: balanceText(words, customer.balancePaise - amount) })}
            </p>
          </Card>
          {error ? (
            <p role="alert" className="flex items-start gap-2 text-base text-danger">
              <Icon name="danger" className="mt-1 shrink-0" />
              <span>
                {t(`new.error.${error}`)}{" "}
                {error === "already_saved_different" && paymentId.current ? (
                  <Link className="underline" href={paymentHref(paymentId.current)}>
                    {t("new.open_payment")}
                  </Link>
                ) : null}
              </span>
            </p>
          ) : null}
          <div className="flex flex-col-reverse gap-3 sm:flex-row">
            <Button
              variant="secondary"
              size="lg"
              icon="back"
              disabled={saving}
              onClick={() => setStep("method")}
            >
              {t("new.back")}
            </Button>
            <Button
              size="lg"
              icon="success"
              loading={saving}
              loadingLabel={t("new.saving")}
              onClick={save}
              data-testid="save-payment"
            >
              {t("new.save")}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
