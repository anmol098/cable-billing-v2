"use client";

/**
 * The Owner's "New bill change" (T-045, PLAN §8.3 "explicit adjustment with a reason", FR-024).
 * One job: pick the customer, say extra charge or take money off, the amount and why; the summary
 * line says what will happen with the number before saving (PLAN §2.2 rules 2 and 7). Nothing is
 * edited: an extra charge goes on the next bill; money taken off is taken off what the customer
 * owes now (oldest bill first).
 */
import {
  AmountInput,
  Button,
  Card,
  Combobox,
  type ComboboxOption,
  formatRupees,
  RadioCards,
  Textarea,
  useToast,
} from "@cb/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import {
  type ManualDirection,
  type ManualErrorKey,
  type ManualInput,
  type ManualResult,
  newFormId,
} from "./results";

const MAX_PAISE = 10_000_000;
const REASON_MIN = 3;
const REASON_MAX = 200;

const rupees = (paise: number) => formatRupees(paise).text.replace(/^₹/, "");

export interface ManualCustomer {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface ManualFormProps {
  readonly initialCustomer: ManualCustomer | null;
  readonly findCustomers: (query: string) => Promise<
    | {
        ok: true;
        customers: readonly {
          id: string;
          code: string;
          name: string;
          phone: string | null;
          areaName: string | null;
        }[];
      }
    | { ok: false }
  >;
  readonly save: (input: ManualInput) => Promise<ManualResult>;
  readonly doneHref: string;
}

export function ManualAdjustmentForm(props: ManualFormProps) {
  const t = useTranslations("adjustments");
  const router = useRouter();
  const { toast } = useToast();
  const ids = useId();
  const formId = useRef(newFormId());
  const found = useRef(new Map<string, ManualCustomer>());
  const [customer, setCustomer] = useState<ManualCustomer | null>(props.initialCustomer);
  const [direction, setDirection] = useState<ManualDirection | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<ManualErrorKey | null>(null);
  const [saving, setSaving] = useState(false);

  const loadOptions = async (query: string): Promise<readonly ComboboxOption[]> => {
    const result = await props.findCustomers(query);
    if (!result.ok) throw new Error("search failed");
    found.current = new Map(
      result.customers.map((c) => [c.id, { id: c.id, code: c.code, name: c.name }]),
    );
    return result.customers.map((c) => ({
      value: c.id,
      label: c.name,
      description: [t("manual.customer_code", { code: c.code }), c.phone, c.areaName]
        .filter(Boolean)
        .join(" · "),
    }));
  };

  const check = (): ManualErrorKey | null => {
    if (!customer) return "customer";
    if (!direction) return "direction";
    if (amount === null || amount < 1 || amount > MAX_PAISE) return "manual_amount";
    if (reason.trim().length < REASON_MIN) return "reason";
    return null;
  };

  const onSave = async () => {
    const found = check();
    if (found || !customer || !direction || amount === null) {
      setProblem(found ?? "generic");
      return;
    }
    setSaving(true);
    setProblem(null);
    let result: ManualResult;
    try {
      result = await props.save({
        id: formId.current,
        customerId: customer.id,
        direction,
        amountPaise: amount,
        reason: reason.trim(),
      });
    } catch {
      result = { ok: false, error: "generic" };
    }
    setSaving(false);
    if (result.ok) {
      toast({ variant: "success", title: t("manual.saved") });
      router.push(props.doneHref);
      router.refresh();
      return;
    }
    setProblem(result.error);
    toast({ variant: "danger", title: t(`error.${result.error}`) });
  };

  const summary =
    customer && direction && amount !== null && amount > 0
      ? t(direction === "debit" ? "manual.summary_debit" : "manual.summary_credit", {
          amount: rupees(amount),
          name: customer.name,
        })
      : null;

  return (
    <Card className="flex flex-col gap-6 p-4 sm:p-6" data-manual-form>
      <div className="flex flex-col gap-2">
        {customer ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col">
              <span className="text-sm text-text-muted">{t("manual.customer")}</span>
              <span className="font-strong text-xl" data-chosen-customer={customer.id}>
                {customer.name}
              </span>
              <span className="font-numeric text-sm text-text-muted">
                {t("manual.customer_code", { code: customer.code })}
              </span>
            </div>
            <Button variant="quiet" icon="search" onClick={() => setCustomer(null)}>
              {t("manual.change_customer")}
            </Button>
          </div>
        ) : (
          <Combobox
            label={t("manual.customer")}
            placeholder={t("manual.customer_placeholder")}
            loadOptions={loadOptions}
            onSelect={(option) => {
              const picked = found.current.get(option.value);
              if (picked) setCustomer(picked);
              setProblem(null);
            }}
            loadingLabel={t("manual.searching")}
            emptyLabel={t("manual.no_match")}
            errorLabel={t("error.generic")}
          />
        )}
        {problem === "customer" ? (
          <p className="text-base text-danger" role="alert">
            {t("error.customer")}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <span id={`${ids}-direction`} className="font-strong text-base">
          {t("manual.direction")}
        </span>
        <RadioCards
          aria-labelledby={`${ids}-direction`}
          className="sm:grid-cols-2"
          value={direction ?? ""}
          onValueChange={(value) => {
            if (value === "debit" || value === "credit") setDirection(value);
            setProblem(null);
          }}
          options={[
            {
              value: "debit",
              label: t("manual.debit"),
              description: t("manual.debit_hint"),
              icon: "add",
              iconClassName: "text-due",
            },
            {
              value: "credit",
              label: t("manual.credit"),
              description: t("manual.credit_hint"),
              icon: "undo",
              iconClassName: "text-credit",
            },
          ]}
        />
        {problem === "direction" ? (
          <p className="text-base text-danger" role="alert">
            {t("error.direction")}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={`${ids}-amount`} className="font-strong text-base">
          {t("manual.amount")}
        </label>
        <AmountInput
          id={`${ids}-amount`}
          value={amount}
          onValueChange={(value) => {
            setAmount(value);
            setProblem(null);
          }}
          maxPaise={MAX_PAISE}
          invalid={problem === "manual_amount"}
          data-field="amount"
        />
        {problem === "manual_amount" ? (
          <p className="text-base text-danger" role="alert">
            {t("error.manual_amount")}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={`${ids}-reason`} className="font-strong text-base">
          {t("manual.reason")}
        </label>
        <Textarea
          id={`${ids}-reason`}
          value={reason}
          maxLength={REASON_MAX}
          onChange={(event) => {
            setReason(event.target.value);
            setProblem(null);
          }}
          aria-describedby={`${ids}-reason-hint`}
          data-field="reason"
        />
        <p id={`${ids}-reason-hint`} className="text-sm text-text-muted">
          {t("manual.reason_hint")}
        </p>
        {problem === "reason" ? (
          <p className="text-base text-danger" role="alert">
            {t("error.reason")}
          </p>
        ) : null}
      </div>

      {summary ? (
        <p
          className={`font-strong text-lg ${direction === "debit" ? "text-due" : "text-credit"}`}
          data-manual-summary
        >
          {summary}
        </p>
      ) : null}
      {problem && !["customer", "direction", "manual_amount", "reason"].includes(problem) ? (
        <p className="text-base text-danger" role="alert">
          {t(`error.${problem}`)}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <Button
          size="lg"
          icon="success"
          onClick={onSave}
          loading={saving}
          data-action="save-manual"
        >
          {t("manual.save")}
        </Button>
        <Button asChild variant="quiet" icon="back">
          <Link href={props.doneHref}>{t("manual.back")}</Link>
        </Button>
      </div>
    </Card>
  );
}
