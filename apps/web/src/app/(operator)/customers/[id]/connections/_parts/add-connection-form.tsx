"use client";

/** "Add connection" on the Connections tab (`?add=1`): the fields, Save connection / Cancel. */
import type { ConnectionPlanOption } from "@cb/core";
import { Button, Card } from "@cb/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useState } from "react";
import { FormMessage } from "../../../_components/form-message";
import { ConnectionFields } from "./connection-fields";
import { type ConnectionFormState, EMPTY_CONNECTION_VALUES } from "./form-state";

type Action = (state: ConnectionFormState, formData: FormData) => Promise<ConnectionFormState>;

export function AddConnectionForm({
  action,
  plans,
  today,
  latestStartDate,
  earliestStartDate,
  cancelHref,
}: {
  action: Action;
  plans: readonly ConnectionPlanOption[];
  today: string;
  latestStartDate: string;
  earliestStartDate: string | null;
  cancelHref: string;
}) {
  const t = useTranslations("connections");
  const [state, formAction, pending] = useActionState(action, {});
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (state.error) setVersion((v) => v + 1);
  }, [state]);

  return (
    <Card className="flex max-w-2xl flex-col gap-5 p-4 sm:p-6">
      <h2 className="font-strong text-xl">{t("form.title")}</h2>
      <form
        action={formAction}
        noValidate
        className="flex flex-col gap-5"
        data-form="add-connection"
      >
        {state.error ? <FormMessage tone="danger">{t(`error.${state.error}`)}</FormMessage> : null}
        <ConnectionFields
          key={version}
          plans={plans}
          values={state.values ?? EMPTY_CONNECTION_VALUES}
          state={state}
          today={today}
          latestStartDate={latestStartDate}
          earliestStartDate={earliestStartDate}
        />
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
          <Button asChild variant="secondary" size="lg" icon="close">
            <Link href={cancelHref}>{t("form.cancel")}</Link>
          </Button>
          <Button
            type="submit"
            size="lg"
            icon="success"
            loading={pending}
            loadingLabel={t("form.saving")}
          >
            {t("form.save")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
