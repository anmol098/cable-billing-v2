"use client";

/**
 * The Owner's "Undo payment" (T-048, PLAN §8.6, BR-13, RULE-20): choose a reason (+ a note; a
 * note is required for "Other reason"), then confirm in a sheet that states the effect with the
 * numbers. Nothing is deleted: the server adds a cancellation (append-only), the bills open again
 * and the receipt shows "Cancelled". Pressing twice cannot cancel twice (the button is locked
 * while it runs, and the server refuses a second cancellation).
 */
import { Button, ConfirmSheet, RadioCards, Textarea, useToast } from "@cb/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import {
  isUndoReason,
  MAX_UNDO_NOTE_LENGTH,
  paymentHref,
  UNDO_REASONS,
  type UndoReason,
} from "./format";
import type { UndoErrorKey, UndoResult } from "./results";

export interface UndoPaymentProps {
  readonly paymentId: string;
  /** Pre-formatted words for the confirm sheet. */
  readonly amount: string;
  readonly customerName: string;
  readonly balanceAfter: string;
  readonly undo: (input: {
    paymentId: string;
    reason: UndoReason;
    note?: string;
  }) => Promise<UndoResult>;
}

export function UndoPayment({
  paymentId,
  amount,
  customerName,
  balanceAfter,
  undo,
}: UndoPaymentProps) {
  const t = useTranslations("payments");
  const common = useTranslations("common");
  const toast = useToast();
  const router = useRouter();
  const reasonId = useId();
  const noteId = useId();
  const busy = useRef(false);
  const [reason, setReason] = useState<UndoReason | null>(null);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<"reason_required" | "note_required" | null>(null);
  const [open, setOpen] = useState(false);

  const check = (): boolean => {
    if (!reason) {
      setProblem("reason_required");
      return false;
    }
    if (reason === "other" && !note.trim()) {
      setProblem("note_required");
      return false;
    }
    setProblem(null);
    return true;
  };

  const errorText = (key: UndoErrorKey) =>
    key === "reason_required" || key === "note_required"
      ? t(`undo.${key}`)
      : t(`undo.error.${key}`);

  const onConfirm = async () => {
    if (busy.current || !reason) throw new Error("busy");
    busy.current = true;
    let result: UndoResult;
    try {
      const trimmed = note.trim();
      result = await undo({ paymentId, reason, ...(trimmed ? { note: trimmed } : {}) });
    } catch {
      result = { ok: false, error: "generic" };
    }
    busy.current = false;
    if (result.ok) {
      router.push(`${paymentHref(paymentId)}?undone=1`);
      router.refresh();
      return;
    }
    toast.toast({ variant: "danger", title: errorText(result.error) });
    if (result.error === "already_cancelled") {
      router.push(paymentHref(paymentId));
      router.refresh();
      return;
    }
    if (result.error === "reason_required" || result.error === "note_required") {
      setProblem(result.error);
    }
    throw new Error("not cancelled");
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <span id={reasonId} className="font-strong text-lg">
          {t("undo.reason_label")}
        </span>
        <RadioCards
          aria-labelledby={reasonId}
          className="sm:grid-cols-2"
          value={reason ?? ""}
          onValueChange={(value) => {
            if (isUndoReason(value)) setReason(value);
            setProblem(null);
          }}
          options={UNDO_REASONS.map((value) => ({
            value,
            label: t(`undo_reason.${value}`),
          }))}
        />
        {problem === "reason_required" ? (
          <p className="text-base text-danger">{t("undo.reason_required")}</p>
        ) : null}
      </div>
      <label htmlFor={noteId} className="flex flex-col gap-2 text-base text-text">
        {t("undo.note_label")}
        <Textarea
          id={noteId}
          value={note}
          maxLength={MAX_UNDO_NOTE_LENGTH}
          invalid={problem === "note_required"}
          onChange={(event) => {
            setNote(event.target.value);
            if (event.target.value.trim()) setProblem(null);
          }}
        />
      </label>
      {problem === "note_required" ? (
        <p className="text-base text-danger">{t("undo.note_required")}</p>
      ) : null}
      <div>
        <Button
          variant="danger"
          size="lg"
          icon="undo"
          onClick={() => {
            if (check()) setOpen(true);
          }}
        >
          {t("undo.confirm")}
        </Button>
      </div>
      <ConfirmSheet
        open={open}
        onOpenChange={setOpen}
        tone="danger"
        title={t("undo.confirm_title")}
        summary={t("undo.confirm_summary", { amount, name: customerName, after: balanceAfter })}
        confirmLabel={t("undo.confirm")}
        confirmIcon="undo"
        loadingLabel={t("undo.confirming")}
        cancelLabel={common("cancel")}
        onConfirm={onConfirm}
      />
    </div>
  );
}
