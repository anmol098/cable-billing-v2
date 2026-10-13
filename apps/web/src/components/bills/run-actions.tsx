"use client";

/**
 * "Make bills now" and "Try problems again" (T-047, PLAN §8.2, J-03; Owner only, D-16). Each asks
 * once in plain words (PLAN §2.2 rule 7: "N customers get a bill, total ₹X" when the preview is
 * open), calls its Server Action, shows the outcome as a toast and reloads the page data. The page
 * renders this only for the Owner; the services refuse anyone else as well.
 */
import { Button, ConfirmSheet, useToast } from "@cb/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { RunActionResult } from "./run-result";

export interface RunActionsProps {
  readonly period: string;
  /** `"November 2026"`, in the page language. */
  readonly monthLabel: string;
  /** Show "Make bills now". */
  readonly canStart: boolean;
  /** The run to retry, when it has failed items and is not running. */
  readonly retryRunId: string | null;
  readonly failedCount: number;
  /** The open preview's numbers, for the confirm sheet (`amount` pre-formatted rupees). */
  readonly preview: { readonly count: number; readonly amount: string } | null;
  readonly start: (input: { period: string }) => Promise<RunActionResult>;
  readonly retry: (input: { runId: string }) => Promise<RunActionResult>;
}

export function RunActions({
  period,
  monthLabel,
  canStart,
  retryRunId,
  failedCount,
  preview,
  start,
  retry,
}: RunActionsProps) {
  const t = useTranslations("bills");
  const common = useTranslations("common");
  const toast = useToast();
  const router = useRouter();

  const call = async (kind: "start" | "retry") => {
    let result: RunActionResult;
    try {
      result =
        kind === "start" ? await start({ period }) : await retry({ runId: retryRunId ?? "" });
    } catch {
      result = { ok: false, error: "generic" };
    }
    if (result.ok) {
      const title =
        result.outcome === "already_running"
          ? t("run.already_running_toast")
          : result.outcome === "nothing_to_retry"
            ? t("retry.nothing_toast")
            : kind === "retry"
              ? t("retry.started_toast")
              : t("run.started_toast");
      toast.toast({ variant: result.outcome === "started" ? "success" : "pending", title });
      router.refresh();
      return;
    }
    toast.toast({ variant: "danger", title: t(`error.${result.error}`) });
    router.refresh();
    // The sheet closes either way: the page reloads with the current state.
  };

  if (!canStart && retryRunId === null) return null;
  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      {canStart ? (
        <ConfirmSheet
          title={t("run.confirm_title", { month: monthLabel })}
          summary={
            preview
              ? t("run.confirm_summary_preview", { count: preview.count, amount: preview.amount })
              : t("run.confirm_summary", { month: monthLabel })
          }
          confirmLabel={t("run.confirm")}
          confirmIcon="bill"
          loadingLabel={t("run.starting")}
          cancelLabel={common("cancel")}
          onConfirm={() => call("start")}
          trigger={
            <Button size="lg" icon="bill">
              {t("run.button")}
            </Button>
          }
        />
      ) : null}
      {retryRunId !== null ? (
        <ConfirmSheet
          title={t("retry.confirm_title")}
          summary={t("retry.confirm_summary", { count: failedCount })}
          confirmLabel={t("retry.confirm")}
          confirmIcon="retry"
          loadingLabel={t("run.starting")}
          cancelLabel={common("cancel")}
          onConfirm={() => call("retry")}
          trigger={
            <Button size="lg" variant="secondary" icon="retry">
              {t("retry.button")}
            </Button>
          }
        />
      ) : null}
    </div>
  );
}
