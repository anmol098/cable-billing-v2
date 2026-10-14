"use client";

/**
 * A new connection's fields (PLAN §12.2: one column, at most 6 per step): VC number, monthly rent
 * (a plan or "Own amount" + the amount), start day. Used by "Add connection" on the Connections
 * tab and by step 2 of "Add customer". Each field shows its problem in words under it.
 */
import type { ConnectionPlanOption } from "@cb/core";
import {
  businessDate,
  type DisplayLocale,
  formatBusinessDate,
  isBusinessDate,
  period,
  periodLabel,
} from "@cb/domain";
import { AmountInput, formatRupees, Icon, Input, Select } from "@cb/ui";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import {
  type ConnectionFieldName,
  type ConnectionFormState,
  type ConnectionFormValues,
  OWN_AMOUNT,
} from "./form-state";

const MAX_RENT_PAISE = 10_000_000;

function Note({ id, hint, error }: { id: string; hint?: ReactNode; error?: ReactNode }) {
  if (error) {
    return (
      <div id={id} className="flex items-start gap-2 text-base text-danger">
        <Icon name="danger" className="mt-1 shrink-0" />
        <div>{error}</div>
      </div>
    );
  }
  if (!hint) return null;
  return (
    <p id={id} className="text-sm text-text-muted">
      {hint}
    </p>
  );
}

export interface ConnectionFieldsProps {
  plans: readonly ConnectionPlanOption[];
  /** Starting values (or what was typed before an error). */
  values: ConnectionFormValues;
  state: ConnectionFormState;
  /** Today (IST), the default start day. */
  today: string;
  /** The latest start day allowed (tomorrow). */
  latestStartDate: string;
  /** The earliest start day allowed (the customer's latest billed month), or null. */
  earliestStartDate: string | null;
  /** Makes the ids unique on the page. */
  idPrefix?: string;
}

const rupees = (paise: number) => formatRupees(paise).text.replace(/^₹/, "");

export function ConnectionFields({
  plans,
  values,
  state,
  today,
  latestStartDate,
  earliestStartDate,
  idPrefix = "connection",
}: ConnectionFieldsProps) {
  const t = useTranslations("connections");
  const locale = useLocale() as DisplayLocale;
  const noPlans = plans.length === 0;
  const [rentChoice, setRentChoice] = useState(noPlans ? OWN_AMOUNT : values.rentChoice);
  const [amountProblem, setAmountProblem] = useState(false);
  const fields = state.fields ?? {};
  const id = (name: ConnectionFieldName) => `${idPrefix}-${name}`;
  const day = (value: string | null | undefined) =>
    value && isBusinessDate(value) ? formatBusinessDate(businessDate(value), locale) : "";

  const errorFor = (name: ConnectionFieldName): ReactNode => {
    const key = fields[name];
    if (!key) return name === "rentalPaise" && amountProblem ? t("error.amount_invalid") : null;
    const holder = state.holder;
    if ((key === "vc_in_use" || key === "vc_in_use_until") && holder) {
      return (
        <span className="flex flex-col gap-1">
          <span>
            {key === "vc_in_use_until"
              ? t("error.vc_in_use_until", {
                  name: holder.name,
                  code: holder.code,
                  date: day(holder.until),
                  next: day(holder.earliestStart),
                })
              : t("error.vc_in_use", { name: holder.name, code: holder.code })}
          </span>
          {holder.customerId ? (
            <Link
              href={`/customers/${holder.customerId}/connections`}
              className="min-h-touch-min py-2 text-accent underline"
            >
              {t("error.vc_open")}
            </Link>
          ) : null}
        </span>
      );
    }
    if (key === "date_billed" && state.billed) {
      const month = state.billed.period;
      return t("error.date_billed", {
        month: isBusinessDate(month) ? periodLabel(period(month), locale) : month,
        date: day(state.billed.earliestDate),
      });
    }
    if (key === "vc_in_use" || key === "vc_in_use_until") return t("error.vc_here");
    return t(`error.${key}`);
  };

  const describedBy = (name: ConnectionFieldName) => `${id(name)}-note`;
  const own = rentChoice === OWN_AMOUNT;
  const initialPaise = /^[0-9]+$/.test(values.rentalPaise) ? Number(values.rentalPaise) : null;

  return (
    <div className="flex flex-col gap-5" data-connection-fields>
      <div className="flex flex-col gap-2" data-field="vcNumber">
        <label htmlFor={id("vcNumber")} className="font-strong text-base">
          {t("form.vc_label")}
        </label>
        <Input
          id={id("vcNumber")}
          name="vcNumber"
          defaultValue={values.vcNumber}
          autoComplete="off"
          inputMode="text"
          maxLength={128}
          className="font-numeric"
          invalid={Boolean(fields.vcNumber)}
          aria-describedby={describedBy("vcNumber")}
        />
        <Note id={describedBy("vcNumber")} hint={t("form.vc_hint")} error={errorFor("vcNumber")} />
      </div>

      <div className="flex flex-col gap-2" data-field="rentChoice">
        <label htmlFor={id("rentChoice")} className="font-strong text-base">
          {t("form.rent_label")}
        </label>
        {noPlans ? (
          <>
            <input type="hidden" name="rentChoice" value={OWN_AMOUNT} />
            <p id={id("rentChoice")} className="text-base text-text-muted">
              {t("form.no_plans")}
            </p>
          </>
        ) : (
          <Select
            id={id("rentChoice")}
            name="rentChoice"
            value={rentChoice}
            onChange={(event) => setRentChoice(event.target.value)}
            placeholder={t("form.rent_choose")}
            invalid={Boolean(fields.rentChoice)}
            aria-describedby={describedBy("rentChoice")}
          >
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {t("form.plan_option", {
                  name: plan.name,
                  amount: rupees(plan.monthlyAmountPaise),
                })}
              </option>
            ))}
            <option value={OWN_AMOUNT}>{t("form.own_amount")}</option>
          </Select>
        )}
        <Note id={describedBy("rentChoice")} error={errorFor("rentChoice")} />
      </div>

      {own ? (
        <div className="flex flex-col gap-2" data-field="rentalPaise">
          <label htmlFor={id("rentalPaise")} className="font-strong text-base">
            {t("form.amount_label")}
          </label>
          <AmountInput
            id={id("rentalPaise")}
            name="rentalPaise"
            defaultValue={initialPaise}
            maxPaise={MAX_RENT_PAISE}
            onValueChange={() => setAmountProblem(false)}
            onReject={() => setAmountProblem(true)}
            invalid={Boolean(fields.rentalPaise) || amountProblem}
            aria-describedby={describedBy("rentalPaise")}
          />
          <Note id={describedBy("rentalPaise")} error={errorFor("rentalPaise")} />
        </div>
      ) : null}

      <div className="flex flex-col gap-2" data-field="startDate">
        <label htmlFor={id("startDate")} className="font-strong text-base">
          {t("form.start_label")}
        </label>
        <Input
          id={id("startDate")}
          name="startDate"
          type="date"
          defaultValue={values.startDate || today}
          max={latestStartDate}
          {...(earliestStartDate ? { min: earliestStartDate } : {})}
          className="font-numeric"
          invalid={Boolean(fields.startDate)}
          aria-describedby={describedBy("startDate")}
        />
        <Note
          id={describedBy("startDate")}
          hint={t("form.start_hint")}
          error={errorFor("startDate")}
        />
      </div>
    </div>
  );
}
