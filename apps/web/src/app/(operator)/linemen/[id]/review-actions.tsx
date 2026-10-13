"use client";

/**
 * Accept / Send back on the review screen (T-062, PLAN §8.7 "Office: Accept (finalised, audited)
 * or Return (with a note)"). Accept asks once, stating the numbers (PLAN §2.2 rule 7); Send back
 * needs a note. After a decision, or when the handover changed underneath (a newer submission, a
 * decision by someone else), the page reloads its data.
 */
import { Button, ConfirmSheet, Dialog, Textarea, useToast } from "@cb/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { isStale, type ReviewActionResult, type ReviewErrorKey } from "../_lib/review-result";

export interface ReviewActionsProps {
  readonly sessionId: string;
  readonly submissionId: string;
  readonly linemanName: string;
  /** Pre-formatted words for the confirm sheet: `₹800`, `₹750`, `₹50 short`. */
  readonly handed: string;
  readonly expected: string;
  readonly difference: string;
  readonly accept: (input: {
    sessionId: string;
    submissionId: string;
  }) => Promise<ReviewActionResult>;
  readonly sendBack: (input: {
    sessionId: string;
    submissionId: string;
    note: string;
  }) => Promise<ReviewActionResult>;
}

export function ReviewActions({
  sessionId,
  submissionId,
  linemanName,
  handed,
  expected,
  difference,
  accept,
  sendBack,
}: ReviewActionsProps) {
  const t = useTranslations("linemen.review");
  const common = useTranslations("common");
  const toast = useToast();
  const router = useRouter();
  const noteId = useId();
  const [backOpen, setBackOpen] = useState(false);
  const [note, setNote] = useState("");
  const [noteMissing, setNoteMissing] = useState(false);
  const [sending, setSending] = useState(false);

  const errorText = (key: ReviewErrorKey) =>
    key === "note_required" ? t("send_back_note_required") : t(`error.${key}`);

  /** Shows the outcome; returns false when the caller should keep its sheet open. */
  const settle = (result: ReviewActionResult): boolean => {
    if (result.ok) {
      toast.toast({
        variant: "success",
        title: result.status === "accepted" ? t("accepted_toast") : t("returned_toast"),
      });
      router.refresh();
      return true;
    }
    toast.toast({ variant: "danger", title: errorText(result.error) });
    if (isStale(result.error)) {
      router.refresh();
      return true;
    }
    return false;
  };

  const onAccept = async () => {
    let result: ReviewActionResult;
    try {
      result = await accept({ sessionId, submissionId });
    } catch {
      result = { ok: false, error: "generic" };
    }
    if (!settle(result)) throw new Error("not accepted");
  };

  const onSendBack = async () => {
    const trimmed = note.trim();
    if (!trimmed) {
      setNoteMissing(true);
      return;
    }
    setSending(true);
    let result: ReviewActionResult;
    try {
      result = await sendBack({ sessionId, submissionId, note: trimmed });
    } catch {
      result = { ok: false, error: "generic" };
    }
    setSending(false);
    if (settle(result)) {
      setBackOpen(false);
      setNote("");
    }
  };

  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <ConfirmSheet
        title={t("accept_title")}
        summary={t("accept_summary", { name: linemanName, handed, expected, difference })}
        confirmLabel={t("accept")}
        confirmIcon="success"
        loadingLabel={t("accepting")}
        cancelLabel={common("cancel")}
        onConfirm={onAccept}
        trigger={
          <Button size="lg" icon="success">
            {t("accept")}
          </Button>
        }
      />
      <Dialog
        title={t("send_back_title")}
        description={t("send_back_summary", { name: linemanName })}
        closeLabel={common("close")}
        open={backOpen}
        onOpenChange={(open) => {
          if (!sending) setBackOpen(open);
        }}
        trigger={
          <Button size="lg" variant="secondary" icon="undo">
            {t("send_back")}
          </Button>
        }
        footer={
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              size="lg"
              disabled={sending}
              onClick={() => setBackOpen(false)}
            >
              {common("cancel")}
            </Button>
            <Button
              variant="danger"
              size="lg"
              icon="undo"
              loading={sending}
              loadingLabel={t("sending_back")}
              onClick={onSendBack}
            >
              {t("send_back")}
            </Button>
          </div>
        }
      >
        <label htmlFor={noteId} className="flex flex-col gap-2 text-base text-text">
          {t("send_back_note_label")}
          <Textarea
            id={noteId}
            value={note}
            maxLength={500}
            invalid={noteMissing}
            aria-describedby={noteMissing ? `${noteId}-error` : undefined}
            onChange={(event) => {
              setNote(event.target.value);
              if (event.target.value.trim()) setNoteMissing(false);
            }}
          />
        </label>
        {noteMissing ? (
          <p id={`${noteId}-error`} className="text-base text-danger">
            {t("send_back_note_required")}
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}
