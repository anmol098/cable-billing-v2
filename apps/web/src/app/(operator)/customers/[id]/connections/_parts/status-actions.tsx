"use client";

/**
 * Stop / Start again / Remove for one connection (FR-006), each behind a ConfirmSheet that asks
 * "from which day?" (and why, for a stop or removal) and says the effect in plain words with the
 * month that changes (PLAN §12.2): "Rent stops from November. ₹450 old due stays."
 *
 * The sheet stays open when the office refuses the change (the problem shows as a toast) and
 * closes after it is saved; the page then reloads its data.
 */
import {
  businessDate,
  type DisplayLocale,
  formatBusinessDate,
  isBusinessDate,
  period,
  periodLabel,
} from "@cb/domain";
import { Button, ConfirmSheet, formatRupees, type IconName, Input, Select, useToast } from "@cb/ui";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { effectLines, type StatusActionName } from "./effect";
import type { StatusChangeError, StatusChangeResult } from "./form-state";

/** The reasons a person can pick (the same list as `@cb/core` STOP_REASONS). */
export const REASONS = [
  "not_paying",
  "customer_asked",
  "moved_away",
  "box_problem",
  "other",
] as const;

export interface StatusCommand {
  readonly assignmentId: string;
  readonly action: StatusActionName;
  readonly effectiveDate: string;
  readonly reason?: string | null;
  readonly note?: string | null;
}

export interface StatusActionsProps {
  assignmentId: string;
  vcNumber: string;
  /** The allowed status actions (from `connections.list`). */
  actions: readonly StatusActionName[];
  today: string;
  /** The earliest day a change may have (start, last change, billed months). */
  earliestChangeDate: string;
  startDate: string;
  lastChangeDate: string;
  /** The customer's balance (> 0 = due), for "₹450 old due stays." */
  duePaise: number;
  /** `changeConnectionStatusAction` bound to the customer id. */
  action: (command: StatusCommand) => Promise<StatusChangeResult>;
}

const STYLE: Record<
  StatusActionName,
  { icon: IconName; tone: "primary" | "danger"; reason: "none" | "optional" | "required" }
> = {
  suspend: { icon: "pause", tone: "danger", reason: "optional" },
  reactivate: { icon: "resume", tone: "primary", reason: "none" },
  disconnect: { icon: "disconnect", tone: "danger", reason: "required" },
};

const rupees = (paise: number) => formatRupees(paise).text.replace(/^₹/, "");

function StatusSheet({ kind, props }: { kind: StatusActionName; props: StatusActionsProps }) {
  const t = useTranslations("connections");
  const locale = useLocale() as DisplayLocale;
  const { toast } = useToast();
  const router = useRouter();
  const [date, setDate] = useState(props.today);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const style = STYLE[kind];
  const idBase = `${kind}-${props.assignmentId}`;
  const day = (value: string | undefined) =>
    value && isBusinessDate(value) ? formatBusinessDate(businessDate(value), locale) : "";

  const reset = (open: boolean) => {
    if (!open) return;
    setDate(props.today);
    setReason("");
    setNote("");
  };

  const messageFor = (problem: StatusChangeError): string => {
    switch (problem.error) {
      case "date_before_start":
        return t("error.date_before_start", { date: day(props.startDate) });
      case "date_before_last_change":
        return t("error.date_before_last_change", { date: day(props.lastChangeDate) });
      case "date_billed":
      case "date_billed_staff":
        return t(`error.${problem.error}`, {
          month:
            problem.period && isBusinessDate(problem.period)
              ? periodLabel(period(problem.period), locale)
              : "",
          date: day(problem.date),
        });
      default:
        return t(`error.${problem.error}`);
    }
  };

  const confirm = async () => {
    let problem: StatusChangeError | null = null;
    if (!isBusinessDate(date)) problem = { error: "date_invalid" };
    else if (date > props.today) problem = { error: "date_future" };
    else if (style.reason === "required" && reason === "") problem = { error: "reason_required" };
    if (!problem) {
      const result = await props.action({
        assignmentId: props.assignmentId,
        action: kind,
        effectiveDate: date,
        reason: style.reason === "none" ? null : reason || null,
        note: reason === "other" ? note : null,
      });
      if (result.ok) {
        toast({ variant: "success", title: t(`done.${kind}`) });
        router.refresh();
        return;
      }
      problem = result;
      if (result.error === "changed") router.refresh();
    }
    toast({ variant: "danger", title: messageFor(problem) });
    // Keep the sheet open so the day or reason can be fixed.
    throw new Error(problem.error);
  };

  const lines = isBusinessDate(date)
    ? effectLines({
        action: kind,
        date: businessDate(date),
        duePaise: props.duePaise,
        locale,
        rupees,
      })
    : [];

  return (
    <ConfirmSheet
      title={t(`confirm.${kind}_title`, { vc: props.vcNumber })}
      summary={
        <div className="flex flex-col gap-4" data-status-sheet={kind}>
          <div className="flex flex-col gap-2">
            <label htmlFor={`${idBase}-date`} className="font-strong text-base">
              {t("confirm.date_label")}
            </label>
            <Input
              id={`${idBase}-date`}
              type="date"
              value={date}
              min={props.earliestChangeDate}
              max={props.today}
              onChange={(event) => setDate(event.target.value)}
              className="font-numeric"
              aria-describedby={`${idBase}-date-hint`}
            />
            <p id={`${idBase}-date-hint`} className="text-sm text-text-muted">
              {t("confirm.date_hint", { date: day(props.earliestChangeDate) })}
            </p>
          </div>
          {style.reason === "none" ? null : (
            <div className="flex flex-col gap-2">
              <label htmlFor={`${idBase}-reason`} className="font-strong text-base">
                {style.reason === "required"
                  ? t("confirm.reason_label")
                  : t("confirm.reason_optional")}
              </label>
              <Select
                id={`${idBase}-reason`}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={t("confirm.reason_choose")}
              >
                {REASONS.map((code) => (
                  <option key={code} value={code}>
                    {t(`reason.${code}`)}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {reason === "other" ? (
            <div className="flex flex-col gap-2">
              <label htmlFor={`${idBase}-note`} className="font-strong text-base">
                {t("confirm.note_label")}
              </label>
              <Input
                id={`${idBase}-note`}
                value={note}
                maxLength={200}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
          ) : null}
          <ul className="flex flex-col gap-2" data-effect>
            {lines.map((line) => (
              <li
                key={line.key}
                className={
                  line.key === "rent_stops" || line.key === "rent_starts"
                    ? "font-strong text-lg"
                    : line.key === "old_due"
                      ? "text-lg text-due"
                      : "text-base"
                }
              >
                {t(`confirm.${line.key}`, line.values)}
              </li>
            ))}
          </ul>
        </div>
      }
      confirmLabel={t(`confirm.${kind}_confirm`)}
      confirmIcon={style.icon}
      cancelLabel={t("action.cancel")}
      tone={style.tone}
      loadingLabel={t("action.saving")}
      onConfirm={confirm}
      onOpenChange={reset}
      trigger={
        <Button variant="secondary" icon={style.icon} data-action={`connection-${kind}`}>
          {t(`action.${kind}`)}
        </Button>
      }
    />
  );
}

/** The status buttons of one connection (nothing for a removed one). */
export function StatusActions(props: StatusActionsProps) {
  if (props.actions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-3" data-status-actions={props.assignmentId}>
      {props.actions.map((kind) => (
        <StatusSheet key={kind} kind={kind} props={props} />
      ))}
    </div>
  );
}
