"use client";

/**
 * The customer's own fields (PLAN §12.2: one column, at most 6 per step): code, name, mobile no.,
 * other mobile no., area, address. Used by step 1 of "Add customer" and by "Change details".
 * Each field shows its problem in words under it (icon + colour + word).
 */
import type { CustomerAreaOption } from "@cb/core";
import { Icon, Input, Select, Textarea } from "@cb/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode, SyntheticEvent } from "react";
import type { CustomerFieldName, CustomerFormState, CustomerFormValues } from "./form-state";
import { FIELD_LIMITS } from "./limits";

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

function Field({
  name,
  label,
  hint,
  error,
  children,
}: {
  name: CustomerFieldName;
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2" data-field={name}>
      <label htmlFor={`customer-${name}`} className="font-strong text-base">
        {label}
      </label>
      {children}
      <Note id={`customer-${name}-note`} hint={hint} error={error} />
    </div>
  );
}

export interface CustomerFieldsProps {
  /** `new`: the code may stay empty (next number). `edit`: the code is required. */
  mode: "new" | "edit";
  areas: readonly CustomerAreaOption[];
  /** The next automatic code (shown in the hint on `new`). */
  nextAutoCode?: string;
  /** Starting values (edit) or what was typed before an error. */
  values: CustomerFormValues;
  state: CustomerFormState;
}

export function CustomerFields({ mode, areas, nextAutoCode, values, state }: CustomerFieldsProps) {
  const t = useTranslations("customers");
  const fields = state.fields ?? {};
  const errorFor = (name: CustomerFieldName): ReactNode => {
    const key = fields[name];
    if (!key) return null;
    if (key === "code_taken") {
      return (
        <span className="flex flex-col gap-1">
          <span>{t("error.code_taken", { code: values.customerCode.trim() })}</span>
          {state.takenBy ? (
            <Link
              href={`/customers/${state.takenBy}`}
              className="min-h-touch-min py-2 text-accent underline"
            >
              {t("error.code_taken_open")}
            </Link>
          ) : null}
        </span>
      );
    }
    return t(`error.${key}`);
  };
  const described = (name: CustomerFieldName) => ({
    id: `customer-${name}`,
    name,
    "aria-describedby": `customer-${name}-note`,
    "aria-invalid": fields[name] ? true : undefined,
  });
  // The browser's own "fill this in" bubble (the Stepper checks required fields) in our words.
  const requiredMessage = {
    onInvalid: (event: SyntheticEvent<HTMLInputElement>) =>
      event.currentTarget.setCustomValidity(t("error.required")),
    onInput: (event: SyntheticEvent<HTMLInputElement>) => event.currentTarget.setCustomValidity(""),
  };
  // Keep the archived area a customer already has; never offer archived areas otherwise.
  const areaChoices = areas.filter((a) => !a.archived || a.id === values.areaId);

  return (
    <div className="flex flex-col gap-5">
      <Field
        name="customerCode"
        label={t("field.code")}
        hint={
          mode === "new"
            ? t("field.code_hint", { next: nextAutoCode ?? "1" })
            : t("field.code_hint_edit")
        }
        error={errorFor("customerCode")}
      >
        <Input
          {...described("customerCode")}
          defaultValue={values.customerCode}
          maxLength={FIELD_LIMITS.customerCode}
          required={mode === "edit"}
          {...(mode === "edit" ? requiredMessage : {})}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="font-numeric text-lg"
          invalid={Boolean(fields.customerCode)}
        />
      </Field>
      <Field name="name" label={t("field.name")} error={errorFor("name")}>
        <Input
          {...described("name")}
          defaultValue={values.name}
          maxLength={FIELD_LIMITS.name}
          required
          {...requiredMessage}
          autoComplete="off"
          className="text-lg"
          invalid={Boolean(fields.name)}
        />
      </Field>
      <Field
        name="phone"
        label={t("field.phone")}
        hint={t("field.phone_hint")}
        error={errorFor("phone")}
      >
        <Input
          {...described("phone")}
          type="tel"
          inputMode="tel"
          defaultValue={values.phone}
          maxLength={FIELD_LIMITS.phoneInput}
          autoComplete="off"
          className="font-numeric text-lg"
          invalid={Boolean(fields.phone)}
        />
      </Field>
      <Field name="altPhone" label={t("field.alt_phone")} error={errorFor("altPhone")}>
        <Input
          {...described("altPhone")}
          type="tel"
          inputMode="tel"
          defaultValue={values.altPhone}
          maxLength={FIELD_LIMITS.phoneInput}
          autoComplete="off"
          className="font-numeric text-lg"
          invalid={Boolean(fields.altPhone)}
        />
      </Field>
      <Field name="areaId" label={t("field.area")} error={errorFor("areaId")}>
        <Select
          {...described("areaId")}
          defaultValue={values.areaId}
          className="text-lg"
          invalid={Boolean(fields.areaId)}
        >
          <option value="">{t("field.area_none")}</option>
          {areaChoices.map((area) => (
            <option key={area.id} value={area.id}>
              {area.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field name="address" label={t("field.address")} error={errorFor("address")}>
        <Textarea
          {...described("address")}
          defaultValue={values.address}
          maxLength={FIELD_LIMITS.address}
          rows={2}
          className="text-lg"
          invalid={Boolean(fields.address)}
        />
      </Field>
    </div>
  );
}
