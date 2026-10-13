"use client";

/**
 * Close a customer / make it active again (FR-003 "deactivate"), with a ConfirmSheet that says
 * what happens in plain words. A customer with running connections can't be closed: the toast
 * says to stop them first (T-034's Connections tab).
 */
import { Button, ConfirmSheet, useToast } from "@cb/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { StatusActionResult } from "./actions";

export function CustomerStatusControl({
  name,
  active,
  action,
}: {
  name: string;
  active: boolean;
  /** `setCustomerStatusAction` bound to the customer id. */
  action: (status: "active" | "inactive") => Promise<StatusActionResult>;
}) {
  const t = useTranslations("customers");
  const { toast } = useToast();
  const router = useRouter();

  const confirm = async () => {
    const result = await action(active ? "inactive" : "active");
    if (result.ok) {
      toast({ variant: "success", title: active ? t("profile.closed") : t("profile.reopened") });
      router.refresh();
      return;
    }
    toast({
      variant: "danger",
      title:
        result.error === "open_connections"
          ? t("error.open_connections", { count: result.count ?? 1 })
          : t(`error.${result.error}`),
    });
  };

  return (
    <ConfirmSheet
      title={active ? t("profile.close_title", { name }) : t("profile.reopen_title", { name })}
      summary={active ? t("profile.close_body", { name }) : t("profile.reopen_body", { name })}
      confirmLabel={active ? t("profile.close_confirm") : t("profile.reopen_confirm")}
      confirmIcon={active ? "close" : "success"}
      cancelLabel={t("profile.cancel")}
      tone={active ? "danger" : "primary"}
      loadingLabel={t("profile.saving")}
      onConfirm={confirm}
      trigger={
        <Button
          variant="secondary"
          icon={active ? "close" : "success"}
          data-action="customer-status"
        >
          {active ? t("profile.close_customer") : t("profile.reopen_customer")}
        </Button>
      }
    />
  );
}
