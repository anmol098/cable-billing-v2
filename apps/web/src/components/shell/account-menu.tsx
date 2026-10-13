"use client";

import { Button, cn, Divider, focusRing, Icon } from "@cb/ui";
import { useCallback, useId, useRef, useState } from "react";
import { useDismiss } from "./use-dismiss";

type FormAction = (formData: FormData) => void | Promise<void>;

/**
 * The account button in the header (icon + word) and its small menu: who is signed in, their
 * role, and the two sign-out buttons (T-026 Server Actions, plain forms).
 */
export function AccountMenu({
  label,
  userName,
  roleLabel,
  signOutLabel,
  signOutEverywhereLabel,
  signOutAction,
  signOutEverywhereAction,
}: {
  /** The button's word ("Account"). */
  label: string;
  userName: string;
  roleLabel: string;
  signOutLabel: string;
  signOutEverywhereLabel: string;
  signOutAction: FormAction;
  signOutEverywhereAction: FormAction;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useDismiss(open, close, container, trigger);

  return (
    <div ref={container} className="relative shrink-0" data-shell="account-menu">
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "inline-flex min-h-touch-min cursor-pointer items-center gap-2 rounded-md border-hairline border-border bg-bg px-3 text-base text-text hover:bg-surface",
          focusRing,
        )}
      >
        <Icon name="customer" className="size-5 shrink-0" />
        <span>{label}</span>
      </button>
      {open ? (
        <div
          id={panelId}
          className="absolute top-full right-0 z-30 mt-2 flex w-72 flex-col gap-3 rounded-lg border-hairline border-border bg-bg p-4"
        >
          <div className="flex flex-col gap-1">
            <p className="truncate font-strong text-base">{userName}</p>
            <p className="text-sm text-text-muted">{roleLabel}</p>
          </div>
          <Divider />
          <form action={signOutAction}>
            <Button type="submit" variant="secondary" icon="logout" className="w-full">
              {signOutLabel}
            </Button>
          </form>
          <form action={signOutEverywhereAction}>
            <Button type="submit" variant="quiet" icon="logout" className="w-full">
              {signOutEverywhereLabel}
            </Button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
