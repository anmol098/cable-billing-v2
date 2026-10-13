"use client";

/**
 * The Owner's business profile form (T-030). One form, three short groups (Business; Receipts
 * and bills; New connection in the middle of the month) and one Save button: in the page header,
 * pinned above the bottom bar on phones (thumb reach, PLAN §2.2 rule 1). Inputs are controlled so
 * typed values stay after an error. The Server Action re-checks everything.
 */
import { Button, Input, PAGE_ACTION_CLEARANCE, RadioCards, Textarea, useToast } from "@cb/ui";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useState } from "react";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { Field, FieldNote, Notice, noteId } from "./field";
import type { ProfileField, ProfileFormState, ProfileValues } from "./form-state";

type Action = (state: ProfileFormState, formData: FormData) => Promise<ProfileFormState>;

export const PROFILE_FORM_ID = "business-profile";

/** Limits shown to the browser (the service has the same ones). */
const MAX = { name: 120, phone: 20, address: 500, receiptFooter: 500, invoicePrefix: 8 } as const;

function upperPrefix(value: string): string {
  return value.trim().replace(/[a-z]/g, (c) => c.toUpperCase());
}

export function ProfileForm({
  title,
  initial,
  exampleSuffix,
  action,
}: {
  /** The page title (the menu word, "Business details"). */
  title: string;
  initial: ProfileValues;
  /** `-YYMM-00001` for this month, so the hint shows a real-looking bill number. */
  exampleSuffix: string;
  action: Action;
}) {
  const t = useTranslations("settings.profile");
  const { toast } = useToast();
  const [state, formAction, pending] = useActionState(action, {});
  const [values, setValues] = useState<Record<ProfileField, string>>({ ...initial });

  useEffect(() => {
    if (!state.saved) return;
    setValues({ ...state.saved.values });
    toast({
      variant: "success",
      title: state.saved.changed > 0 ? t("saved") : t("nothing_changed"),
    });
  }, [state.saved, toast, t]);

  const set = (field: ProfileField) => (value: string) =>
    setValues((current) => ({ ...current, [field]: value }));
  const error = (field: ProfileField) => {
    const key = state.fields?.[field];
    return key ? t(`error.${key}`) : undefined;
  };
  const describedBy = (field: ProfileField) => ({
    "aria-describedby": noteId(field),
    invalid: Boolean(state.fields?.[field]),
  });

  return (
    <div className={`flex flex-col gap-6 ${PAGE_ACTION_CLEARANCE}`}>
      <ShellPageHeader
        title={title}
        description={t("description")}
        action={
          <Button
            type="submit"
            form={PROFILE_FORM_ID}
            size="lg"
            icon="success"
            loading={pending}
            loadingLabel={t("saving")}
          >
            {t("save")}
          </Button>
        }
      />
      {state.error ? <Notice tone="danger">{t(`error.${state.error}`)}</Notice> : null}
      <form id={PROFILE_FORM_ID} action={formAction} noValidate className="flex flex-col gap-8">
        <fieldset className="flex flex-col gap-5">
          <legend className="mb-4 font-strong text-xl">{t("section_business")}</legend>
          <Field id="name" label={t("name_label")} hint={t("name_hint")} error={error("name")}>
            <Input
              id="name"
              name="name"
              value={values.name}
              onChange={(e) => set("name")(e.target.value)}
              maxLength={MAX.name}
              autoComplete="organization"
              required
              {...describedBy("name")}
            />
          </Field>
          <Field id="phone" label={t("phone_label")} hint={t("phone_hint")} error={error("phone")}>
            <Input
              id="phone"
              name="phone"
              type="tel"
              inputMode="tel"
              value={values.phone}
              onChange={(e) => set("phone")(e.target.value)}
              maxLength={MAX.phone + 10}
              autoComplete="tel"
              className="font-numeric"
              {...describedBy("phone")}
            />
          </Field>
          <Field
            id="address"
            label={t("address_label")}
            hint={t("address_hint")}
            error={error("address")}
          >
            <Textarea
              id="address"
              name="address"
              value={values.address}
              onChange={(e) => set("address")(e.target.value)}
              maxLength={MAX.address}
              autoComplete="street-address"
              {...describedBy("address")}
            />
          </Field>
        </fieldset>

        <fieldset className="flex flex-col gap-5">
          <legend className="mb-4 font-strong text-xl">{t("section_receipts")}</legend>
          <Field
            id="receiptFooter"
            label={t("footer_label")}
            hint={t("footer_hint")}
            error={error("receiptFooter")}
          >
            <Textarea
              id="receiptFooter"
              name="receiptFooter"
              rows={2}
              value={values.receiptFooter}
              onChange={(e) => set("receiptFooter")(e.target.value)}
              maxLength={MAX.receiptFooter}
              {...describedBy("receiptFooter")}
            />
          </Field>
          <div className="flex flex-col gap-2">
            <label htmlFor="invoicePrefix" className="font-strong text-base">
              {t("prefix_label")}
            </label>
            <Input
              id="invoicePrefix"
              name="invoicePrefix"
              value={values.invoicePrefix}
              onChange={(e) => set("invoicePrefix")(e.target.value)}
              maxLength={MAX.invoicePrefix}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className="max-w-48 font-numeric uppercase"
              aria-describedby={`${noteId("invoicePrefix")} invoicePrefix-when`}
              invalid={Boolean(state.fields?.invoicePrefix)}
            />
            <FieldNote
              id="invoicePrefix"
              hint={t("prefix_hint", {
                example: `${upperPrefix(values.invoicePrefix) || "INV"}${exampleSuffix}`,
              })}
              {...(error("invoicePrefix") ? { error: error("invoicePrefix") } : {})}
            />
            <p id="invoicePrefix-when" className="flex items-start gap-2 text-sm text-text">
              <span aria-hidden className="text-pending">
                •
              </span>
              <span>{t("prefix_when")}</span>
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <p id="defaultLanguage-label" className="font-strong text-base">
              {t("language_label")}
            </p>
            <RadioCards
              name="defaultLanguage"
              value={values.defaultLanguage}
              onValueChange={set("defaultLanguage")}
              aria-labelledby="defaultLanguage-label"
              aria-describedby={noteId("defaultLanguage")}
              className="sm:grid-cols-2"
              options={[
                { value: "hi", label: "हिंदी", icon: "language" },
                { value: "en", label: "English", icon: "language" },
              ]}
            />
            <FieldNote
              id="defaultLanguage"
              hint={t("language_hint")}
              {...(error("defaultLanguage") ? { error: error("defaultLanguage") } : {})}
            />
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-4">
          <legend className="mb-4 font-strong text-xl">{t("section_mid_month")}</legend>
          <p id="midMonthStartPolicy-label" className="text-base">
            {t("mid_month_question")}
          </p>
          <RadioCards
            name="midMonthStartPolicy"
            value={values.midMonthStartPolicy}
            onValueChange={set("midMonthStartPolicy")}
            aria-labelledby="midMonthStartPolicy-label"
            aria-describedby={noteId("midMonthStartPolicy")}
            options={[
              {
                value: "charge_full_month",
                label: t("mid_month_charge"),
                description: t("mid_month_charge_explain"),
                icon: "bill",
              },
              {
                value: "start_next_month",
                label: t("mid_month_next"),
                description: t("mid_month_next_explain"),
                icon: "next",
              },
            ]}
          />
          <FieldNote
            id="midMonthStartPolicy"
            hint={t("mid_month_note")}
            {...(error("midMonthStartPolicy") ? { error: error("midMonthStartPolicy") } : {})}
          />
        </fieldset>
      </form>
    </div>
  );
}
