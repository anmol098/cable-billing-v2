"use client";

/** "Change details" on the Summary tab: the customer's six fields, Save changes / Cancel. */
import type { CustomerAreaOption } from "@cb/core";
import { Button, Card } from "@cb/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useState } from "react";
import { CustomerFields } from "../../_components/customer-fields";
import { FormMessage } from "../../_components/form-message";
import type { CustomerFormState, CustomerFormValues } from "../../_components/form-state";

type Action = (state: CustomerFormState, formData: FormData) => Promise<CustomerFormState>;

export function EditCustomerForm({
  action,
  areas,
  initial,
  cancelHref,
}: {
  action: Action;
  areas: readonly CustomerAreaOption[];
  initial: CustomerFormValues;
  cancelHref: string;
}) {
  const t = useTranslations("customers");
  const [state, formAction, pending] = useActionState(action, {});
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (state.error) setVersion((v) => v + 1);
  }, [state]);

  return (
    <Card className="flex max-w-2xl flex-col gap-5 p-4 sm:p-6">
      <h2 className="font-strong text-xl">{t("profile.edit_title")}</h2>
      <form
        action={formAction}
        noValidate
        className="flex flex-col gap-5"
        data-form="edit-customer"
      >
        {state.error ? <FormMessage tone="danger">{t(`error.${state.error}`)}</FormMessage> : null}
        <CustomerFields
          key={version}
          mode="edit"
          areas={areas}
          values={state.values ?? initial}
          state={state}
        />
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
          <Button asChild variant="secondary" size="lg" icon="close">
            <Link href={cancelHref}>{t("profile.cancel")}</Link>
          </Button>
          <Button
            type="submit"
            size="lg"
            icon="success"
            loading={pending}
            loadingLabel={t("profile.saving")}
          >
            {t("profile.save_changes")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
