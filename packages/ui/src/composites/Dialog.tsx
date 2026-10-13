"use client";

import * as RadixDialog from "@radix-ui/react-dialog";
import type { ReactElement, ReactNode } from "react";
import { cn } from "../lib/cn";
import { IconButton } from "../primitives/IconButton";

export type DialogProps = {
  /** The dialog's heading (an i18n string); also its accessible name. */
  title: ReactNode;
  /** One sentence under the title; also the accessible description. */
  description?: ReactNode;
  /** The word on the close button (`common.close`): its accessible name and tooltip. */
  closeLabel: string;
  /** The element that opens the dialog (a `Button`); rendered as-is with Radix's trigger props. */
  trigger?: ReactElement;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The body. */
  children?: ReactNode;
  /** Buttons at the bottom, e.g. `<Button>Save</Button>`: one primary at most (PLAN §2.2). */
  footer?: ReactNode;
  className?: string;
};

/**
 * The page behind is covered by the `surface` colour: tokens have no scrim colour and opacity
 * utilities are not allowed (hyper-minimal), and a dialog is "one screen = one job" anyway.
 */
export const dialogOverlayClasses = "fixed inset-0 z-40 bg-surface";

/** Centred panel from `sm` up (128 spacing units wide); on phones the full width minus a margin. */
export const dialogPanelClasses = [
  "fixed inset-x-4 top-1/2 z-50 flex max-h-11/12 -translate-y-1/2 flex-col gap-4 overflow-y-auto",
  "rounded-lg border-hairline border-border bg-bg p-6 text-text outline-none",
  "sm:inset-x-auto sm:left-1/2 sm:w-128 sm:-translate-x-1/2",
].join(" ");

/**
 * Focus the panel itself when it opens (not its first button): screen readers read the title and
 * description first, and no action (or the close tooltip) is pre-selected.
 */
export function focusPanel(event: Event): void {
  event.preventDefault();
  (event.currentTarget as HTMLElement | null)?.focus();
}

/**
 * A modal dialog: title + body + footer, closed by its close button, Escape or a click outside.
 * Focus moves into the dialog and returns to the trigger when it closes (Radix Dialog).
 */
export function Dialog({
  title,
  description,
  closeLabel,
  trigger,
  open,
  defaultOpen,
  onOpenChange,
  children,
  footer,
  className,
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      {trigger ? <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger> : null}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={dialogOverlayClasses} />
        <RadixDialog.Content
          className={cn(dialogPanelClasses, className)}
          onOpenAutoFocus={focusPanel}
          // Without a description Radix warns unless aria-describedby is explicitly unset.
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-2">
              <RadixDialog.Title className="font-strong text-xl text-text">
                {title}
              </RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="text-base text-text-muted">
                  {description}
                </RadixDialog.Description>
              ) : null}
            </div>
            <RadixDialog.Close asChild>
              <IconButton icon="close" label={closeLabel} variant="quiet" className="shrink-0" />
            </RadixDialog.Close>
          </div>
          {children}
          {footer ? (
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">{footer}</div>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** A button inside the dialog that closes it (e.g. a "Cancel" `Button`). */
export const DialogClose = RadixDialog.Close;
