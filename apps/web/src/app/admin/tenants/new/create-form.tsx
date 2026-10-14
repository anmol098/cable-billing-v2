"use client";

/** The "Add operator" form (T-086): six fields, one button, errors in words next to the form. */
import { Button, Input, Select } from "@cb/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { Field, Outcome } from "../../_components/parts";
import type { CreateTenantState } from "../actions";

const TEXT_FIELDS = [
  {
    name: "businessName",
    key: "business_name",
    type: "text",
    autoComplete: "organization",
    required: true,
  },
  {
    name: "businessPhone",
    key: "business_phone",
    type: "tel",
    autoComplete: "tel",
    required: false,
  },
  { name: "ownerName", key: "owner_name", type: "text", autoComplete: "name", required: true },
  { name: "ownerEmail", key: "owner_email", type: "email", autoComplete: "email", required: true },
  { name: "ownerMobile", key: "owner_mobile", type: "tel", autoComplete: "tel", required: true },
] as const;

export function CreateTenantForm({
  operatorId,
  action,
}: {
  operatorId: string;
  action: (state: CreateTenantState, form: FormData) => Promise<CreateTenantState>;
}) {
  const t = useTranslations("admin");
  const [state, formAction, pending] = useActionState(action, {});
  const wrong = new Set(state.fields ?? []);
  return (
    <form action={formAction} className="flex max-w-xl flex-col gap-4" noValidate>
      <input type="hidden" name="operatorId" value={operatorId} />
      {state.error ? <Outcome tone="danger">{t(`create.error.${state.error}`)}</Outcome> : null}
      {TEXT_FIELDS.map((f) => (
        <Field key={f.name} id={f.name} label={t(`create.field.${f.key}`)}>
          <Input
            id={f.name}
            name={f.name}
            type={f.type}
            autoComplete={f.autoComplete}
            required={f.required}
            invalid={wrong.has(f.name)}
            defaultValue={state.values?.[f.name] ?? ""}
          />
        </Field>
      ))}
      <Field id="language" label={t("create.field.language")}>
        <Select id="language" name="language" defaultValue={state.values?.language ?? "hi"}>
          <option value="hi">{t("create.language.hi")}</option>
          <option value="en">{t("create.language.en")}</option>
        </Select>
      </Field>
      <p className="text-base text-text-muted">{t("create.explain")}</p>
      <div>
        <Button type="submit" icon="add" loading={pending} loadingLabel={t("common.working")}>
          {t("create.submit")}
        </Button>
      </div>
    </form>
  );
}
