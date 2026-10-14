"use client";

/**
 * "Mark as checked" for a payment that came in flagged (T-048, PLAN §10.4 `posted_needs_review`).
 * One dialog: what it does in plain words (the money stays as it is), an optional note, one
 * button. Someone else checking it first is said plainly and the page reloads.
 */
import { Button, Dialog, Textarea, useToast } from "@cb/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import type { ResolveResult } from "./results";

export interface ResolveReviewProps {
  readonly paymentId: string;
  /** Pre-formatted words for the dialog: `₹500`, the customer's name. */
  readonly amount: string;
  readonly customerName: string;
  readonly resolve: (input: { paymentId: string; note?: string }) => Promise<ResolveResult>;
}

export function ResolveReview({ paymentId, amount, customerName, resolve }: ResolveReviewProps) {
  const t = useTranslations("payments.check");
  const common = useTranslations("common");
  const toast = useToast();
  const router = useRouter();
  const noteId = useId();
  const busy = useRef(false);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const onConfirm = async () => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    let result: ResolveResult;
    try {
      const trimmed = note.trim();
      result = await resolve({ paymentId, ...(trimmed ? { note: trimmed } : {}) });
    } catch {
      result = { ok: false, error: "generic" };
    }
    setSaving(false);
    busy.current = false;
    if (result.ok) {
      toast.toast({ variant: "success", title: t("marked") });
      setOpen(false);
      router.refresh();
      return;
    }
    toast.toast({ variant: "danger", title: t(`error.${result.error}`) });
    if (result.error === "already_resolved" || result.error === "not_flagged") {
      setOpen(false);
      router.refresh();
    }
  };

  return (
    <Dialog
      title={t("mark_title")}
      description={t("mark_summary", { amount, name: customerName })}
      closeLabel={common("close")}
      open={open}
      onOpenChange={(next) => {
        if (!saving) setOpen(next);
      }}
      trigger={
        <Button size="lg" icon="success">
          {t("mark")}
        </Button>
      }
      footer={
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="secondary" size="lg" disabled={saving} onClick={() => setOpen(false)}>
            {common("cancel")}
          </Button>
          <Button
            size="lg"
            icon="success"
            loading={saving}
            loadingLabel={t("marking")}
            onClick={onConfirm}
          >
            {t("mark")}
          </Button>
        </div>
      }
    >
      <label htmlFor={noteId} className="flex flex-col gap-2 text-base text-text">
        {t("note_label")}
        <Textarea
          id={noteId}
          value={note}
          maxLength={500}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
    </Dialog>
  );
}
