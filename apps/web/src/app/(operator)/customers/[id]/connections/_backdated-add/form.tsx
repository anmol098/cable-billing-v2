"use client";

/**
 * The Owner's "Add connection" (T-045a, PLAN §8.3, D-18): T-034's fields, and when the start day is
 * in a month whose bills are already made, the effect **before saving**, month by month with the
 * numbers ("September 2026: ₹300 extra will be added to the next bill. … In all: ₹900 more to
 * pay."), and "Why are you changing old bills?". Saving then makes the explicit bill changes with
 * that reason; nothing edits a bill. The preview is the server's own calculation
 * (`adjustments.preview_add`), so it says exactly what saving will do.
 *
 * Any other start day saves as a plain add (T-034). Staff keep T-034's form, which refuses a billed
 * month ("Bills for … are already made").
 */
import type { ConnectionPlanOption } from "@cb/core";
import type { DisplayLocale } from "@cb/domain";
import { Button, Card, formatRupees, Icon, Textarea } from "@cb/ui";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import { FormMessage } from "../../../_components/form-message";
import { ConnectionFields } from "../_parts/connection-fields";
import { connectionValuesFrom, EMPTY_CONNECTION_VALUES } from "../_parts/form-state";
import type { ChangeErrorKey } from "../_plan-change/results";
import { addEffectText } from "./effect-text";
import {
  type AddPreviewData,
  type AddPreviewInput,
  type AddPreviewResult,
  type BackDatedAddFormState,
  previewInputFrom,
  REASON_MAX,
} from "./state";

const rupees = (paise: number) => formatRupees(paise).text.replace(/^₹/, "");

type SaveAction = (
  state: BackDatedAddFormState,
  formData: FormData,
) => Promise<BackDatedAddFormState>;

export interface BackDatedAddFormProps {
  readonly save: SaveAction;
  readonly preview: (input: AddPreviewInput) => Promise<AddPreviewResult>;
  readonly plans: readonly ConnectionPlanOption[];
  readonly today: string;
  readonly latestStartDate: string;
  readonly cancelHref: string;
}

type PreviewState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: AddPreviewData }
  | { readonly status: "error"; readonly error: ChangeErrorKey };

export function BackDatedAddForm(props: BackDatedAddFormProps) {
  const t = useTranslations("connections");
  const ta = useTranslations("adjustments");
  // The effect lines' keys are computed (./effect-text.ts), so they are not literal key types.
  const say = ta as unknown as (key: string, values?: Record<string, string>) => string;
  const locale = useLocale() as DisplayLocale;
  const ids = useId();
  const [state, formAction, pending] = useActionState(props.save, {});
  const [version, setVersion] = useState(0);
  const [edits, setEdits] = useState(0);
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const formRef = useRef<HTMLFormElement>(null);
  const asked = useRef<{ key: string; request: number }>({ key: "", request: 0 });

  useEffect(() => {
    // The bills changed since the preview: ask for it again (the key no longer matches).
    if (state.stale) asked.current = { key: "", request: asked.current.request };
    if (state.error || state.stale) setVersion((v) => v + 1);
  }, [state]);

  // After each edit (and once at the start), ask the server what the rent and day would do to the
  // bills; only when they changed, and stale answers are ignored. Runs after the render, so the
  // fields' hidden values (the amount in paise) are up to date.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `edits` and `version` mark new input.
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const input = previewInputFrom(connectionValuesFrom(new FormData(form)));
    const key = JSON.stringify(input);
    if (key === asked.current.key) return;
    const request = asked.current.request + 1;
    asked.current = { key, request };
    if (!input) {
      setPreview({ status: "idle" });
      return;
    }
    setPreview({ status: "loading" });
    props
      .preview(input)
      .then((result) => {
        if (asked.current.request !== request) return;
        setPreview(
          result.ok
            ? { status: "ready", data: result.preview }
            : { status: "error", error: result.error },
        );
      })
      .catch(() => {
        if (asked.current.request === request) setPreview({ status: "error", error: "generic" });
      });
  }, [edits, version]);

  const ready = preview.status === "ready" ? preview.data : null;
  const backDated = ready?.backDated ?? false;
  const text = ready && backDated ? addEffectText(ready, { locale, rupees, isOwner: true }) : null;
  const toneClass = (tone: "due" | "credit" | "plain") =>
    tone === "due" ? "text-due" : tone === "credit" ? "text-credit" : "text-text";

  return (
    <Card className="flex max-w-2xl flex-col gap-5 p-4 sm:p-6">
      <h2 className="font-strong text-xl">{t("form.title")}</h2>
      <form
        ref={formRef}
        action={formAction}
        onChange={() => setEdits((n) => n + 1)}
        noValidate
        className="flex flex-col gap-5"
        data-form="add-connection"
        data-backdated={backDated ? "1" : "0"}
      >
        {state.stale ? (
          <FormMessage tone="danger">{ta("add_backdated.stale")}</FormMessage>
        ) : state.error ? (
          <FormMessage tone="danger">{t(`error.${state.error}`)}</FormMessage>
        ) : null}
        <ConnectionFields
          key={version}
          plans={props.plans}
          values={state.values ?? EMPTY_CONNECTION_VALUES}
          state={state}
          today={props.today}
          latestStartDate={props.latestStartDate}
          // The Owner may choose a day in a month whose bills are made (with a reason below).
          earliestStartDate={null}
        />

        {preview.status === "error" ? (
          <p className="flex items-center gap-2 text-base text-danger" role="alert">
            <Icon name="danger" className="shrink-0" />
            {ta(`error.${preview.error}`)}
          </p>
        ) : null}

        {text && ready ? (
          <>
            <input type="hidden" name="backDated" value="1" />
            {/* What the Owner was shown: the server refuses to charge anything else. */}
            <input type="hidden" name="previewTotal" value={String(ready.totalPaise)} />
            <section
              aria-live="polite"
              aria-labelledby={`${ids}-effect`}
              className="flex flex-col gap-2 border-hairline border-border p-4"
              data-effect-preview="ready"
            >
              <h3 id={`${ids}-effect`} className="font-strong text-base text-text-muted">
                {ta("effect.title")}
              </h3>
              <p className="font-strong text-lg" data-effect-line="headline">
                {say(text.headline.key, text.headline.values)}
              </p>
              <ul className="flex flex-col gap-1">
                {text.months.map((line, index) => (
                  <li
                    key={ready.months[index]?.period ?? index}
                    className={`text-lg ${toneClass(line.tone)}`}
                    data-effect-month={ready.months[index]?.period}
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
                  className="flex items-center gap-2 text-base text-pending"
                  data-effect-line="billed"
                >
                  <Icon name="pending" className="shrink-0" />
                  {say(text.billed.key, text.billed.values)}
                </p>
              ) : null}
            </section>

            <div className="flex flex-col gap-2" data-field="reason">
              <label htmlFor={`${ids}-reason`} className="font-strong text-base">
                {ta("backdate.reason_label")}
              </label>
              <Textarea
                key={version}
                id={`${ids}-reason`}
                name="reason"
                defaultValue={state.reason ?? ""}
                maxLength={REASON_MAX}
                invalid={state.reasonMissing === true}
                aria-describedby={`${ids}-reason-note`}
              />
              {state.reasonMissing ? (
                <p
                  id={`${ids}-reason-note`}
                  className="flex items-start gap-2 text-base text-danger"
                  role="alert"
                >
                  <Icon name="danger" className="mt-1 shrink-0" />
                  {ta("error.reason")}
                </p>
              ) : (
                <p id={`${ids}-reason-note`} className="text-sm text-text-muted">
                  {ta("backdate.reason_hint")}
                </p>
              )}
            </div>
          </>
        ) : null}

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
          <Button asChild variant="secondary" size="lg" icon="close">
            <Link href={props.cancelHref}>{t("form.cancel")}</Link>
          </Button>
          <Button
            type="submit"
            size="lg"
            icon="success"
            loading={pending}
            loadingLabel={t("form.saving")}
            disabled={preview.status === "loading"}
          >
            {backDated ? ta("backdate.save") : t("form.save")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
