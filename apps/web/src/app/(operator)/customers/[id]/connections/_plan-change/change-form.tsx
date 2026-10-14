"use client";

/**
 * Change a connection's plan (Owner, Staff) or, for the Owner, change it from an earlier day whose
 * bills are already made (T-045, PLAN §8.3, D-14, BR-07, FR-008). One job per screen: pick the new
 * plan (or what changed), the day, and see **before saving** what it does to the bills, month by
 * month, with the numbers: "October: ₹50 extra will be added to the next bill. In all: ₹50 more to
 * pay." The preview is the server's own calculation (`adjustments.preview_change`), so it says
 * exactly what saving will do.
 *
 * - A date that reaches back into a billed month: Staff see "ask the owner" and can't save; the
 *   Owner must write a reason, and saving makes an explicit bill change for each month.
 * - Nothing here edits a bill: the server adds bill changes (adjustments).
 */
import { businessDate, type DisplayLocale, formatBusinessDate, isBusinessDate } from "@cb/domain";
import {
  AmountInput,
  Button,
  Card,
  formatRupees,
  Icon,
  Input,
  RadioCards,
  Select,
  Textarea,
  useToast,
} from "@cb/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { effectText } from "./effect-text";
import {
  type ChangeErrorKey,
  type ChangeInput,
  type ChangeKind,
  type PreviewData,
  type PreviewResult,
  type SaveResult,
  STOP_REASONS,
  type StopReasonCode,
} from "./results";

/** Largest own amount (paise): ₹1,00,000 (the core limit). */
const MAX_RENT_PAISE = 10_000_000;
const REASON_MIN = 3;
const REASON_MAX = 200;

const rupees = (paise: number) => formatRupees(paise).text.replace(/^₹/, "");

export interface PlanOption {
  readonly id: string;
  readonly name: string;
  readonly monthlyAmountPaise: number;
}

export interface ConnectionChangeFormProps {
  readonly assignmentId: string;
  readonly vcNumber: string;
  /** `plan`: change plan; `backdate`: the Owner's change from an earlier day. */
  readonly mode: "plan" | "backdate";
  readonly isOwner: boolean;
  /** The changes allowed now (backdate mode shows them as choices). */
  readonly kinds: readonly ChangeKind[];
  readonly plans: readonly PlanOption[];
  readonly currentPlanId: string | null;
  readonly currentRentalPaise: number;
  readonly today: string;
  /** The earliest day allowed (the start or the latest change). */
  readonly minDate: string;
  readonly preview: (input: ChangeInput) => Promise<PreviewResult>;
  readonly save: (
    input: ChangeInput & { backDated: boolean; reason?: string | null },
  ) => Promise<SaveResult>;
  readonly doneHref: string;
  readonly cancelHref: string;
}

type PreviewState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: PreviewData }
  | { readonly status: "error"; readonly error: ChangeErrorKey };

export function ConnectionChangeForm(props: ConnectionChangeFormProps) {
  const t = useTranslations("adjustments");
  const tc = useTranslations("connections");
  // The effect lines' keys are computed (./effect-text.ts), so they are not literal key types.
  const say = t as unknown as (key: string, values?: Record<string, string>) => string;
  const locale = useLocale() as DisplayLocale;
  const router = useRouter();
  const { toast } = useToast();
  const ids = useId();
  const [kind, setKind] = useState<ChangeKind>(
    props.mode === "plan" ? "plan" : (props.kinds[0] ?? "plan"),
  );
  const [planChoice, setPlanChoice] = useState<string>(
    props.currentPlanId && props.plans.some((p) => p.id === props.currentPlanId)
      ? props.currentPlanId
      : props.plans.length > 0
        ? ""
        : "own",
  );
  const [ownPaise, setOwnPaise] = useState<number | null>(
    props.currentPlanId ? null : props.currentRentalPaise,
  );
  const [date, setDate] = useState(props.today);
  const [stopReason, setStopReason] = useState<StopReasonCode | "">("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ChangeErrorKey | null>(null);
  const latest = useRef(0);

  const input: ChangeInput | null = (() => {
    if (!isBusinessDate(date)) return null;
    const base = { assignmentId: props.assignmentId, effectiveDate: date, kind };
    if (kind === "plan") {
      if (planChoice === "own") {
        return ownPaise === null ? null : { ...base, rentalPaise: ownPaise };
      }
      return planChoice ? { ...base, planId: planChoice } : null;
    }
    if (kind === "disconnect" && !stopReason) return null;
    return { ...base, stopReason: stopReason || null };
  })();
  const inputKey = JSON.stringify(input);

  // Ask the server what the change would do whenever the choice changes (stale answers ignored).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `inputKey` stands for `input`.
  useEffect(() => {
    if (!input) {
      setPreview({ status: "idle" });
      return;
    }
    const request = latest.current + 1;
    latest.current = request;
    setPreview({ status: "loading" });
    props
      .preview(input)
      .then((result) => {
        if (latest.current !== request) return;
        setPreview(
          result.ok
            ? { status: "ready", data: result.preview }
            : { status: "error", error: result.error },
        );
      })
      .catch(() => {
        if (latest.current === request) setPreview({ status: "error", error: "generic" });
      });
  }, [inputKey]);

  const ready = preview.status === "ready" ? preview.data : null;
  const backDated = props.mode === "backdate" || (ready?.backDated ?? false);
  const needsReason = props.isOwner && backDated;
  const blocked = (ready?.backDated ?? false) && !props.isOwner;
  const reasonOk = !needsReason || reason.trim().length >= REASON_MIN;
  const canSave =
    !saving && input !== null && ready !== null && !ready.noChange && !blocked && reasonOk;
  const text = ready ? effectText(ready, { locale, rupees, isOwner: props.isOwner }) : null;

  const onSave = async () => {
    if (!input || !canSave) {
      if (needsReason && !reasonOk) setSaveError("reason");
      return;
    }
    setSaving(true);
    setSaveError(null);
    let result: SaveResult;
    try {
      result = await props.save({
        ...input,
        backDated,
        reason: needsReason ? reason.trim() : null,
      });
    } catch {
      result = { ok: false, error: "generic" };
    }
    setSaving(false);
    if (result.ok) {
      toast({
        variant: "success",
        title: t(props.mode === "plan" && !backDated ? "plan_change.saved" : "backdate.saved"),
      });
      router.push(props.doneHref);
      router.refresh();
      return;
    }
    setSaveError(result.error);
    toast({ variant: "danger", title: t(`error.${result.error}`) });
  };

  const toneClass = (tone: "due" | "credit" | "plain") =>
    tone === "due" ? "text-due" : tone === "credit" ? "text-credit" : "text-text";
  const dayText = isBusinessDate(props.minDate)
    ? formatBusinessDate(businessDate(props.minDate), locale)
    : "";

  return (
    <Card
      className="flex flex-col gap-6 p-4 sm:p-6"
      data-change-form={props.mode}
      data-assignment={props.assignmentId}
    >
      <div className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 font-strong text-xl">
          <Icon name={props.mode === "plan" ? "plan" : "edit"} className="shrink-0" />
          {t(props.mode === "plan" ? "plan_change.title" : "backdate.title", {
            vc: props.vcNumber,
          })}
        </h2>
        <p className="font-numeric text-lg">
          {t("plan_change.now", { amount: rupees(props.currentRentalPaise) })}
        </p>
        {props.mode === "backdate" ? (
          <p className="text-base text-text-muted">{t("backdate.description")}</p>
        ) : null}
      </div>

      {props.mode === "backdate" ? (
        <div className="flex flex-col gap-2">
          <span id={`${ids}-kind`} className="font-strong text-base">
            {t("backdate.what")}
          </span>
          <RadioCards
            aria-labelledby={`${ids}-kind`}
            className="sm:grid-cols-2"
            value={kind}
            onValueChange={(value) => {
              const next = props.kinds.find((k) => k === value);
              if (next) setKind(next);
            }}
            options={props.kinds.map((value) => ({
              value,
              label: t(`backdate.kind.${value}`),
              icon:
                value === "plan"
                  ? "plan"
                  : value === "suspend"
                    ? "pause"
                    : value === "reactivate"
                      ? "resume"
                      : "disconnect",
            }))}
          />
        </div>
      ) : null}

      {kind === "plan" ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor={`${ids}-plan`} className="font-strong text-base">
              {t("plan_change.new_plan")}
            </label>
            <Select
              id={`${ids}-plan`}
              value={planChoice}
              onChange={(event) => setPlanChoice(event.target.value)}
              data-field="plan"
            >
              <option value="" disabled>
                {t("plan_change.new_plan")}
              </option>
              {props.plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {t("plan_change.plan_option", {
                    name: plan.name,
                    amount: rupees(plan.monthlyAmountPaise),
                  })}
                </option>
              ))}
              <option value="own">{t("plan_change.own_amount")}</option>
            </Select>
          </div>
          {planChoice === "own" ? (
            <div className="flex flex-col gap-2">
              <label htmlFor={`${ids}-own`} className="font-strong text-base">
                {t("plan_change.own_amount_label")}
              </label>
              <AmountInput
                id={`${ids}-own`}
                value={ownPaise}
                onValueChange={setOwnPaise}
                maxPaise={MAX_RENT_PAISE}
                data-field="own-amount"
              />
            </div>
          ) : null}
        </div>
      ) : kind === "suspend" || kind === "disconnect" ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={`${ids}-stop`} className="font-strong text-base">
            {t("backdate.stop_reason")}
          </label>
          <Select
            id={`${ids}-stop`}
            value={stopReason}
            onChange={(event) => {
              const next = STOP_REASONS.find((r) => r === event.target.value);
              setStopReason(next ?? "");
            }}
            placeholder={t("backdate.stop_reason_choose")}
          >
            {STOP_REASONS.map((code) => (
              <option key={code} value={code}>
                {tc(`reason.${code}`)}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <label htmlFor={`${ids}-date`} className="font-strong text-base">
          {t("plan_change.from_day")}
        </label>
        <Input
          id={`${ids}-date`}
          type="date"
          value={date}
          min={props.minDate}
          max={props.today}
          onChange={(event) => setDate(event.target.value)}
          className="font-numeric"
          aria-describedby={`${ids}-date-hint`}
          data-field="date"
        />
        <p id={`${ids}-date-hint`} className="text-sm text-text-muted">
          {t("plan_change.from_day_hint")} {dayText ? `(${dayText})` : null}
        </p>
      </div>

      <section
        aria-live="polite"
        aria-labelledby={`${ids}-effect`}
        className="flex flex-col gap-2 border-hairline border-border p-4"
        data-effect-preview={preview.status}
      >
        <h3 id={`${ids}-effect`} className="font-strong text-base text-text-muted">
          {t("effect.title")}
        </h3>
        {preview.status === "loading" ? (
          <p className="text-base text-text-muted">{t("effect.checking")}</p>
        ) : null}
        {preview.status === "error" ? (
          <p className="flex items-center gap-2 text-base text-danger" role="alert">
            <Icon name="danger" className="shrink-0" />
            {t(`error.${preview.error}`)}
          </p>
        ) : null}
        {text ? (
          <>
            <p className="font-strong text-lg" data-effect-line="headline">
              {say(text.headline.key, text.headline.values)}
            </p>
            <ul className="flex flex-col gap-1">
              {text.months.map((line, index) => (
                <li
                  key={`${line.key}-${ready?.months[index]?.period ?? index}`}
                  className={`text-lg ${toneClass(line.tone)}`}
                  data-effect-month={ready?.months[index]?.period}
                >
                  {say(line.key, line.values)}
                </li>
              ))}
            </ul>
            {text.total && text.months.length > 1 ? (
              <p
                className={`font-strong text-lg ${toneClass(text.total.tone)}`}
                data-effect-line="total"
              >
                {say(text.total.key, text.total.values)}
              </p>
            ) : null}
            {text.billed ? (
              <p
                className={`flex items-center gap-2 text-base ${blocked ? "text-danger" : "text-pending"}`}
                data-effect-line="billed"
              >
                <Icon name={blocked ? "danger" : "pending"} className="shrink-0" />
                {say(text.billed.key, text.billed.values)}
              </p>
            ) : null}
          </>
        ) : null}
      </section>

      {needsReason ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={`${ids}-reason`} className="font-strong text-base">
            {t("backdate.reason_label")}
          </label>
          <Textarea
            id={`${ids}-reason`}
            value={reason}
            maxLength={REASON_MAX}
            onChange={(event) => {
              setReason(event.target.value);
              setSaveError(null);
            }}
            aria-describedby={`${ids}-reason-hint`}
            data-field="reason"
          />
          <p id={`${ids}-reason-hint`} className="text-sm text-text-muted">
            {t("backdate.reason_hint")}
          </p>
          {saveError === "reason" ? (
            <p className="text-base text-danger" role="alert">
              {t("error.reason")}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <Button
          size="lg"
          icon="success"
          onClick={onSave}
          disabled={!canSave}
          loading={saving}
          data-action="save-change"
        >
          {t(needsReason ? "backdate.save" : "plan_change.save")}
        </Button>
        <Button asChild variant="quiet" icon="close">
          <Link href={props.cancelHref}>{t("plan_change.cancel")}</Link>
        </Button>
      </div>
    </Card>
  );
}
