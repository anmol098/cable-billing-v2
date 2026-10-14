"use client";

/**
 * "Add customer" (PLAN §12.2): a 3-step Stepper inside one form — 1 Customer (the six fields),
 * 2 Connections (VC) (a slot: T-034 passes its fields as `connectionsStep` and what step 3 shows
 * for them as `connectionsCheck`; without them a note says connections are added after saving),
 * 3 Check & save (what was typed, in words). After a failed save the form goes back to the step
 * the state names (`state.step`, default step 1) and shows what is wrong under the field.
 */
import type { CustomerAreaOption } from "@cb/core";
import { Stepper } from "@cb/ui";
import { useTranslations } from "next-intl";
import { type ReactNode, useActionState, useEffect, useRef, useState } from "react";
import { CustomerFields } from "../_components/customer-fields";
import { FormMessage } from "../_components/form-message";
import {
  type CustomerFormState,
  type CustomerFormValues,
  EMPTY_VALUES,
  valuesFrom,
} from "../_components/form-state";

type Action = (state: CustomerFormState, formData: FormData) => Promise<CustomerFormState>;

export interface AddCustomerFormProps {
  /** May return a richer state (T-034 adds step 2's problems); it comes back to `connectionsStep`. */
  action: Action;
  areas: readonly CustomerAreaOption[];
  nextAutoCode: string;
  /**
   * Step 2's fields (T-034), or a function of the last save's state and a counter that changes
   * after each failed save (use it as a `key` to show what was typed). Default: a note that
   * connections are added after saving.
   */
  connectionsStep?: ReactNode | ((state: CustomerFormState, version: number) => ReactNode);
  /** What step 3 shows for step 2's fields, from the form's data when step 3 opened (T-034). */
  connectionsCheck?: (form: FormData) => ReactNode;
}

function CheckRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b-hairline border-border py-3 sm:flex-row sm:gap-4">
      <dt className="text-sm text-text-muted sm:w-48 sm:shrink-0">{label}</dt>
      <dd className="text-lg">{value}</dd>
    </div>
  );
}

export function AddCustomerForm({
  action,
  areas,
  nextAutoCode,
  connectionsStep,
  connectionsCheck,
}: AddCustomerFormProps) {
  const t = useTranslations("customers");
  const common = useTranslations("common");
  const [state, formAction, pending] = useActionState(action, {});
  const [step, setStep] = useState(0);
  const [typed, setTyped] = useState<CustomerFormValues>(EMPTY_VALUES);
  const [snapshot, setSnapshot] = useState<FormData | null>(null);
  const [version, setVersion] = useState(0);
  const form = useRef<HTMLFormElement>(null);

  // A failed save: back to the fields, which re-mount with what was typed and the problems.
  useEffect(() => {
    if (state.error) {
      setStep(state.step ?? 0);
      setVersion((v) => v + 1);
    }
  }, [state]);

  const onStepChange = (next: number) => {
    if (next === 2 && form.current) {
      const data = new FormData(form.current);
      setTyped(valuesFrom(data));
      setSnapshot(data);
    }
    setStep(next);
  };

  const notWritten = <span className="text-text-muted">{t("new.not_written")}</span>;
  const text = (value: string) => (value.trim() === "" ? notWritten : value.trim());
  const areaName = areas.find((a) => a.id === typed.areaId)?.name;

  return (
    <form ref={form} action={formAction} noValidate className="flex flex-col gap-6">
      {state.error ? <FormMessage tone="danger">{t(`error.${state.error}`)}</FormMessage> : null}
      <Stepper
        step={step}
        onStepChange={onStepChange}
        backLabel={common("back")}
        nextLabel={common("next")}
        finishLabel={t("new.save")}
        finishingLabel={t("new.saving")}
        finishing={pending}
        progressLabel={(current, total) => t("new.progress", { current, total })}
        steps={[
          {
            id: "customer",
            title: t("new.step_customer"),
            content: (
              <CustomerFields
                key={version}
                mode="new"
                areas={areas}
                nextAutoCode={nextAutoCode}
                values={state.values ?? EMPTY_VALUES}
                state={state}
              />
            ),
          },
          {
            id: "connections",
            title: t("new.step_connections"),
            content:
              typeof connectionsStep === "function"
                ? connectionsStep(state, version)
                : (connectionsStep ?? (
                    <p className="text-base text-text-muted">{t("new.connections_later")}</p>
                  )),
          },
          {
            id: "check",
            title: t("new.step_check"),
            content: (
              <div className="flex flex-col gap-3">
                <p className="text-base text-text-muted">{t("new.check_intro")}</p>
                <dl data-check="customer">
                  <CheckRow
                    label={t("field.code")}
                    value={
                      typed.customerCode.trim() === "" ? (
                        t("new.code_auto", { next: nextAutoCode })
                      ) : (
                        <span className="font-numeric">{typed.customerCode.trim()}</span>
                      )
                    }
                  />
                  <CheckRow label={t("field.name")} value={text(typed.name)} />
                  <CheckRow
                    label={t("field.phone")}
                    value={<span className="font-numeric">{text(typed.phone)}</span>}
                  />
                  <CheckRow
                    label={t("field.alt_phone")}
                    value={<span className="font-numeric">{text(typed.altPhone)}</span>}
                  />
                  <CheckRow label={t("field.area")} value={areaName ?? t("field.area_none")} />
                  <CheckRow label={t("field.address")} value={text(typed.address)} />
                </dl>
                {connectionsCheck && snapshot ? connectionsCheck(snapshot) : null}
              </div>
            ),
          },
        ]}
      />
    </form>
  );
}
