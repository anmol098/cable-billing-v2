"use client";

import * as RadixDialog from "@radix-ui/react-dialog";
import { type ReactElement, type ReactNode, useState } from "react";
import type { IconName } from "../icons";
import { cn } from "../lib/cn";
import { Button } from "../primitives/Button";
import { dialogOverlayClasses, focusPanel } from "./Dialog";

export type ConfirmSheetTone = "primary" | "danger";

export type ConfirmSheetProps = {
  /** A question in plain words, e.g. "Stop this connection?" */
  title: ReactNode;
  /**
   * What will happen, in plain language with the numbers that matter (PLAN §12.2): "Ramesh's
   * Set-top box 12345 will stop. Rent stops from **November**. ₹450 old due stays."
   */
  summary: ReactNode;
  /** The confirm word, e.g. "Stop connection" / "Save". */
  confirmLabel: string;
  /** The way out, e.g. `common.cancel`. */
  cancelLabel: string;
  /** Icon on the confirm button (icon + colour + word). */
  confirmIcon?: IconName;
  /** `danger` for reversals and stops (red button). Default `primary`. */
  tone?: ConfirmSheetTone;
  /**
   * Runs on confirm. While its promise is pending the button shows `loadingLabel` and the sheet
   * can't be closed; when it resolves the sheet closes. If it throws, the sheet stays open (show
   * the problem with a Toast).
   */
  onConfirm: () => void | Promise<void>;
  /** Word on the confirm button while `onConfirm` runs, e.g. "Saving…". */
  loadingLabel?: string;
  /** The element that opens the sheet (a `Button`). */
  trigger?: ReactElement;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
};

/** A sheet from the bottom edge on phones (thumb reach); a centred panel from `sm` up. */
const SHEET = [
  "fixed inset-x-0 bottom-0 z-50 flex max-h-11/12 flex-col gap-6 overflow-y-auto",
  "rounded-t-lg border-t-hairline border-border bg-bg p-6 text-text outline-none",
  "sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:w-128 sm:-translate-x-1/2 sm:-translate-y-1/2",
  "sm:rounded-lg sm:border-hairline",
].join(" ");

/**
 * "Confirm before money moves / before anything stops" (PLAN §2.2 rule 7): states the effect in
 * plain words, then one confirm button and one way out. An alert dialog: a tap outside does not
 * close it; Escape and the cancel button do.
 */
export function ConfirmSheet({
  title,
  summary,
  confirmLabel,
  cancelLabel,
  confirmIcon,
  tone = "primary",
  onConfirm,
  loadingLabel,
  trigger,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  className,
}: ConfirmSheetProps) {
  const [openState, setOpenState] = useState(defaultOpen);
  const [busy, setBusy] = useState(false);
  const open = openProp ?? openState;

  const setOpen = (next: boolean) => {
    if (busy && !next) return;
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  };

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
      setBusy(false);
      if (openProp === undefined) setOpenState(false);
      onOpenChange?.(false);
    } catch {
      setBusy(false);
    }
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={setOpen}>
      {trigger ? <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger> : null}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={dialogOverlayClasses} />
        <RadixDialog.Content
          role="alertdialog"
          className={cn(SHEET, className)}
          onOpenAutoFocus={focusPanel}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <RadixDialog.Title className="font-strong text-xl text-text">{title}</RadixDialog.Title>
          <RadixDialog.Description asChild>
            <div className="text-lg text-text">{summary}</div>
          </RadixDialog.Description>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <RadixDialog.Close asChild>
              <Button variant="secondary" size="lg" disabled={busy}>
                {cancelLabel}
              </Button>
            </RadixDialog.Close>
            <Button
              variant={tone === "danger" ? "danger" : "primary"}
              size="lg"
              icon={confirmIcon}
              loading={busy}
              loadingLabel={loadingLabel}
              onClick={confirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
