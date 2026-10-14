"use client";

/**
 * "Add customer" with step 2 filled in (T-034, PLAN §12.2: Customer → Connections → Check & save):
 * T-033's `AddCustomerForm` with the connection fields as step 2 (one set-top box; more can be
 * added on the Connections tab later; an empty VC box means "no connection now") and the
 * connection's line on the Check & save step.
 */
import type { ConnectionPlanOption, CustomerAreaOption } from "@cb/core";
import { businessDate, type DisplayLocale, formatBusinessDate, isBusinessDate } from "@cb/domain";
import { formatRupees } from "@cb/ui";
import { useLocale, useTranslations } from "next-intl";
import { ConnectionFields } from "../../../[id]/connections/_parts/connection-fields";
import {
  connectionValuesFrom,
  EMPTY_CONNECTION_VALUES,
  OWN_AMOUNT,
} from "../../../[id]/connections/_parts/form-state";
import { AddCustomerForm } from "../../add-customer-form";
import type { AddCustomerState } from "./state";

type Action = (state: AddCustomerState, formData: FormData) => Promise<AddCustomerState>;

export interface AddCustomerWithConnectionProps {
  action: Action;
  areas: readonly CustomerAreaOption[];
  nextAutoCode: string;
  plans: readonly ConnectionPlanOption[];
  today: string;
  latestStartDate: string;
}

const rupees = (paise: number) => formatRupees(paise).text.replace(/^₹/, "");

/** Step 3's line for the connection. */
function ConnectionCheck({
  form,
  plans,
}: {
  form: FormData;
  plans: readonly ConnectionPlanOption[];
}) {
  const t = useTranslations("connections");
  const locale = useLocale() as DisplayLocale;
  const values = connectionValuesFrom(form);
  const vc = values.vcNumber.trim();
  const plan = plans.find((p) => p.id === values.rentChoice);
  const paise =
    values.rentChoice === OWN_AMOUNT && /^[0-9]+$/.test(values.rentalPaise)
      ? Number(values.rentalPaise)
      : (plan?.monthlyAmountPaise ?? null);
  const date = isBusinessDate(values.startDate)
    ? formatBusinessDate(businessDate(values.startDate), locale)
    : values.startDate;
  return (
    <dl data-check="connection">
      <div className="flex flex-col gap-1 border-b-hairline border-border py-3 sm:flex-row sm:gap-4">
        <dt className="text-sm text-text-muted sm:w-48 sm:shrink-0">{t("form.check_title")}</dt>
        <dd className="text-lg">
          {vc === "" ? (
            <span className="text-text-muted">{t("form.check_none")}</span>
          ) : (
            <span className="font-numeric">
              {t("form.check_value", {
                vc,
                amount: paise === null ? "—" : rupees(paise),
                date,
              })}
            </span>
          )}
        </dd>
      </div>
    </dl>
  );
}

export function AddCustomerWithConnection({
  action,
  areas,
  nextAutoCode,
  plans,
  today,
  latestStartDate,
}: AddCustomerWithConnectionProps) {
  const t = useTranslations("connections");
  return (
    <AddCustomerForm
      action={action}
      areas={areas}
      nextAutoCode={nextAutoCode}
      connectionsStep={(state, version) => {
        // The state is what `action` returned (an AddCustomerState).
        const connection = (state as AddCustomerState).connection;
        return (
          <div className="flex flex-col gap-5" data-step-connections>
            <p className="text-base text-text-muted">{t("form.step_intro")}</p>
            <ConnectionFields
              key={version}
              idPrefix="new-connection"
              plans={plans}
              values={connection?.values ?? EMPTY_CONNECTION_VALUES}
              state={connection ?? {}}
              today={today}
              latestStartDate={latestStartDate}
              earliestStartDate={null}
            />
          </div>
        );
      }}
      connectionsCheck={(form) => <ConnectionCheck form={form} plans={plans} />}
    />
  );
}
