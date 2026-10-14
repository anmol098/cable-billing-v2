"use client";

/**
 * The Plans page body (T-031): the list (name, rent a month, how many connections, "Hidden"), and
 * for the Owner "Add plan" (page header), "Change" and "Hide" / "Show again" on each row. Staff
 * (and the Owner while the tenant is read-only) see the list without buttons. Every action is
 * checked again on the server.
 *
 * Changing the rent of a plan that connections are on asks first, with the count: those
 * connections keep paying the old rent, only connections added from now pay the new one, and
 * bills already made never change (FR-007). Moving a connection to the new rent is a plan change
 * on that connection (T-045).
 */
import type { PlanView, SettingsReadOnlyReason } from "@cb/core";
import {
  Amount,
  AmountInput,
  Button,
  ConfirmSheet,
  Dialog,
  EmptyState,
  formatRupees,
  Icon,
  Input,
  PAGE_ACTION_CLEARANCE,
  useToast,
} from "@cb/ui";
import { useTranslations } from "next-intl";
import { type FormEvent, useId, useState, useTransition } from "react";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { FieldNote, Notice, noteId } from "../profile/field";
import {
  MAX_PLAN_PAISE,
  type PlanActionResult,
  type PlanErrorKey,
  planErrorField,
} from "./action-state";

/** The four Server Actions (passed in so tests can use fakes). Amounts are paise. */
export interface PlanActions {
  create(name: string, monthlyAmountPaise: number | null): Promise<PlanActionResult>;
  update(
    planId: string,
    name: string,
    monthlyAmountPaise: number | null,
  ): Promise<PlanActionResult>;
  retire(planId: string): Promise<PlanActionResult>;
  restore(planId: string): Promise<PlanActionResult>;
}

/** Whole rupees without the `₹` (messages add it: "₹{amount}"). */
const rupees = (paise: number) => formatRupees(paise).text.replace(/^₹/, "");

/** Add or change: name and rent, Save. Keeps the dialog open and says what is wrong. */
function PlanDialog({
  plan,
  open,
  onOpenChange,
  onSave,
}: {
  /** `null`: a new plan. */
  plan: PlanView | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (name: string, monthlyAmountPaise: number | null) => Promise<PlanActionResult>;
}) {
  const t = useTranslations("plans");
  const common = useTranslations("common");
  const id = useId();
  const nameId = `${id}-name`;
  const amountId = `${id}-amount`;
  const [name, setName] = useState(plan?.name ?? "");
  const [amount, setAmount] = useState<number | null>(plan?.monthlyAmountPaise ?? null);
  const [error, setError] = useState<PlanErrorKey | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  const field = error ? planErrorField(error) : null;
  const priceChanges = plan !== null && amount !== null && amount !== plan.monthlyAmountPaise;

  const save = () =>
    startTransition(async () => {
      const result = await onSave(name, amount);
      if (result.ok) {
        onOpenChange(false);
      } else {
        setConfirming(false);
        setError(result.error);
      }
    });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (amount === null) {
      setError("amount_required");
      return;
    }
    // Ask before changing the rent of a plan that connections are on (they keep the old rent).
    if (plan !== null && priceChanges && plan.connectionCount > 0) {
      setConfirming(true);
      return;
    }
    save();
  };

  if (confirming && plan !== null && amount !== null) {
    return (
      <Dialog
        title={t("price_title", { amount: rupees(amount) })}
        closeLabel={common("close")}
        open={open}
        onOpenChange={onOpenChange}
      >
        <div className="flex flex-col gap-4" data-plan-price-confirm>
          <p className="text-base">
            {t("price_summary", {
              count: plan.connectionCount,
              old: rupees(plan.monthlyAmountPaise),
            })}
          </p>
          <p className="text-base">{t("price_new", { amount: rupees(amount) })}</p>
          <p className="text-sm text-text-muted">{t("price_how")}</p>
          <div className="flex flex-col gap-3 sm:flex-row-reverse">
            <Button
              size="lg"
              icon="success"
              loading={pending}
              loadingLabel={t("saving")}
              onClick={save}
            >
              {t("price_confirm")}
            </Button>
            <Button
              size="lg"
              variant="secondary"
              icon="back"
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              {t("back")}
            </Button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={plan ? t("edit_title") : t("add_title")}
      closeLabel={common("close")}
      open={open}
      onOpenChange={onOpenChange}
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error && field === null ? <Notice tone="danger">{t(`error.${error}`)}</Notice> : null}
        <div className="flex flex-col gap-2">
          <label htmlFor={nameId} className="font-strong text-base">
            {t("name_label")}
          </label>
          <Input
            id={nameId}
            name="name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            maxLength={60}
            autoComplete="off"
            required
            invalid={field === "name"}
            aria-describedby={noteId(nameId)}
          />
          <FieldNote
            id={nameId}
            {...(field === "name" && error
              ? { error: t(`error.${error}`) }
              : { hint: t("name_hint") })}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor={amountId} className="font-strong text-base">
            {t("amount_label")}
          </label>
          <AmountInput
            id={amountId}
            defaultValue={amount}
            maxPaise={MAX_PLAN_PAISE}
            onValueChange={(paise) => {
              setAmount(paise);
              setError(null);
            }}
            onReject={() => setError("amount_invalid")}
            required
            invalid={field === "amount"}
            aria-describedby={noteId(amountId)}
          />
          <FieldNote
            id={amountId}
            {...(field === "amount" && error
              ? { error: t(`error.${error}`) }
              : { hint: plan ? t("amount_hint_edit") : t("amount_hint_add") })}
          />
        </div>
        <Button type="submit" size="lg" icon="success" loading={pending} loadingLabel={t("saving")}>
          {t("save")}
        </Button>
      </form>
    </Dialog>
  );
}

type Editing = { kind: "add" } | { kind: "edit"; plan: PlanView } | null;

export function PlansManager({
  title,
  plans,
  editable,
  readOnlyReason,
  actions,
}: {
  title: string;
  plans: readonly PlanView[];
  editable: boolean;
  readOnlyReason: SettingsReadOnlyReason | null;
  actions: PlanActions;
}) {
  const t = useTranslations("plans");
  const settings = useTranslations("settings");
  const common = useTranslations("common");
  const { toast } = useToast();
  const [editing, setEditing] = useState<Editing>(null);
  const [hiding, setHiding] = useState<PlanView | null>(null);
  const [restoring, startRestore] = useTransition();

  const fail = (error: PlanErrorKey) => toast({ variant: "danger", title: t(`error.${error}`) });

  /** Runs an action; on success shows `done` (or "Nothing changed"). Returns the result. */
  const perform = async (call: Promise<PlanActionResult>, done: string) => {
    const result = await call;
    if (result.ok) {
      toast({ variant: "success", title: result.changed === false ? t("nothing_changed") : done });
    }
    return result;
  };

  const addButton = (
    <Button size="lg" icon="add" onClick={() => setEditing({ kind: "add" })}>
      {t("add")}
    </Button>
  );

  return (
    <div className={`flex flex-col gap-6 ${editable ? PAGE_ACTION_CLEARANCE : ""}`}>
      <ShellPageHeader
        title={title}
        description={t("description")}
        {...(editable ? { action: addButton } : {})}
      />
      {readOnlyReason ? (
        <Notice tone="pending">{settings(`read_only.${readOnlyReason}`)}</Notice>
      ) : null}

      {plans.length === 0 ? (
        <EmptyState icon="plan" message={editable ? t("empty") : t("empty_staff")} />
      ) : (
        <ul aria-label={t("list_label")} className="flex flex-col gap-3">
          {plans.map((plan) => {
            const hidden = plan.status === "retired";
            return (
              <li
                key={plan.id}
                data-plan={plan.name}
                className="flex flex-col gap-3 rounded-lg border-hairline border-border bg-bg p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <Icon
                    name="plan"
                    className={hidden ? "mt-1 shrink-0 text-text-muted" : "mt-1 shrink-0"}
                  />
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <Amount
                        paise={plan.monthlyAmountPaise}
                        size="2xl"
                        weight="strong"
                        {...(hidden ? { className: "text-text-muted" } : {})}
                      />
                      <span className="text-sm text-text-muted">{t("per_month")}</span>
                    </span>
                    <span className="break-words font-strong text-lg">{plan.name}</span>
                    <span className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
                      <span className="font-numeric">
                        {t("connections", { count: plan.connectionCount })}
                      </span>
                      {hidden ? (
                        <span className="inline-flex items-center gap-1 rounded-full border-hairline border-border px-2 text-text">
                          <Icon name="hide" className="size-4 shrink-0" />
                          {t("hidden")}
                        </span>
                      ) : null}
                    </span>
                  </div>
                </div>
                {editable ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      icon="edit"
                      aria-label={`${t("edit")}: ${plan.name}`}
                      onClick={() => setEditing({ kind: "edit", plan })}
                    >
                      {t("edit")}
                    </Button>
                    {hidden ? (
                      <Button
                        variant="secondary"
                        icon="show"
                        aria-label={`${t("show_again")}: ${plan.name}`}
                        loading={restoring}
                        onClick={() =>
                          startRestore(async () => {
                            const result = await perform(actions.restore(plan.id), t("shown_done"));
                            if (!result.ok) fail(result.error);
                          })
                        }
                      >
                        {t("show_again")}
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        icon="hide"
                        aria-label={`${t("hide")}: ${plan.name}`}
                        onClick={() => setHiding(plan)}
                      >
                        {t("hide")}
                      </Button>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {editing ? (
        <PlanDialog
          key={editing.kind === "add" ? "add" : editing.plan.id}
          plan={editing.kind === "add" ? null : editing.plan}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSave={(name, amount) =>
            editing.kind === "add"
              ? perform(actions.create(name, amount), t("added"))
              : perform(actions.update(editing.plan.id, name, amount), t("saved"))
          }
        />
      ) : null}

      {hiding ? (
        <ConfirmSheet
          open
          onOpenChange={(open) => {
            if (!open) setHiding(null);
          }}
          title={t("hide_title", { name: hiding.name })}
          summary={t("hide_summary", { count: hiding.connectionCount })}
          confirmLabel={t("hide_confirm")}
          confirmIcon="hide"
          cancelLabel={common("cancel")}
          loadingLabel={t("saving")}
          onConfirm={async () => {
            const result = await perform(actions.retire(hiding.id), t("hidden_done"));
            if (!result.ok) fail(result.error);
          }}
        />
      ) : null}
    </div>
  );
}
