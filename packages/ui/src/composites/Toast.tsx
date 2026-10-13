"use client";

import * as RadixToast from "@radix-ui/react-toast";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon, type IconName } from "../icons";
import { cn } from "../lib/cn";
import { focusRing } from "../lib/styles";

/** Same meanings, icons and colours as StatusPill (PLAN §2.2 rule 4). */
export type ToastVariant = "success" | "pending" | "danger";

const VARIANT: Record<ToastVariant, { icon: IconName; className: string }> = {
  success: { icon: "success", className: "text-success" },
  pending: { icon: "pending", className: "text-pending" },
  danger: { icon: "danger", className: "text-danger" },
};

export type ToastOptions = {
  variant: ToastVariant;
  /**
   * A few honest words (an i18n string): "Saved", "Saved on phone", "WhatsApp opened". Never claim
   * a message was sent or delivered (CLAUDE.md "Honest states").
   */
  title: string;
  /** One more sentence, if needed. */
  description?: string;
  /** Milliseconds before it hides. Default: the provider's `duration`. Problems stay until closed. */
  duration?: number;
};

type ToastItem = ToastOptions & { id: number };

type ToastApi = {
  /** Shows a toast and returns its id. */
  toast: (options: ToastOptions) => number;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

/** `toast({ variant, title })` from any component inside `ToastProvider`. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast() must be used inside <ToastProvider>.");
  return api;
}

export type ToastProviderProps = {
  children?: ReactNode;
  /** The word on each toast's close button (`common.close`). */
  closeLabel: string;
  /**
   * Screen-reader name of the toast area, e.g. "Notifications". Radix also announces it with the
   * keyboard shortcut (F8) that jumps there.
   */
  label: string;
  /** Default time on screen in ms. 6 s: low-literacy readers need longer than the usual 5 s. */
  duration?: number;
};

/**
 * Hosts toasts: put it once near the root (inside the i18n provider), then call
 * `useToast().toast(...)`. Toasts appear at the bottom on phones and bottom-right from `sm` up,
 * are announced politely (problems assertively), and can be swiped or closed.
 */
export function ToastProvider({
  children,
  closeLabel,
  label,
  duration = 6000,
}: ToastProviderProps) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const lastId = useRef(0);

  // No exit animation (hyper-minimal), so a closed toast is simply removed.
  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback((options: ToastOptions) => {
    lastId.current += 1;
    const id = lastId.current;
    setItems((current) => [...current, { ...options, id }]);
    return id;
  }, []);

  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      <RadixToast.Provider label={label} duration={duration} swipeDirection="down">
        {children}
        {items.map((item) => {
          const style = VARIANT[item.variant];
          const sticky = item.variant === "danger" && item.duration === undefined;
          return (
            <RadixToast.Root
              key={item.id}
              open
              type={item.variant === "danger" ? "foreground" : "background"}
              duration={sticky ? Number.POSITIVE_INFINITY : item.duration}
              onOpenChange={(open) => {
                if (!open) dismiss(item.id);
              }}
              data-variant={item.variant}
              className="flex items-start gap-3 rounded-lg border-hairline border-border bg-bg p-4 text-text"
            >
              <Icon name={style.icon} className={cn("mt-1 size-6 shrink-0", style.className)} />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <RadixToast.Title className="font-strong text-base">{item.title}</RadixToast.Title>
                {item.description ? (
                  <RadixToast.Description className="text-sm text-text-muted">
                    {item.description}
                  </RadixToast.Description>
                ) : null}
              </div>
              <RadixToast.Close
                aria-label={closeLabel}
                className={cn(
                  "inline-flex size-touch-min shrink-0 cursor-pointer items-center justify-center rounded-md text-text hover:bg-surface",
                  focusRing,
                )}
              >
                <Icon name="close" className="size-5" />
              </RadixToast.Close>
            </RadixToast.Root>
          );
        })}
        <RadixToast.Viewport className="fixed inset-x-0 bottom-0 z-50 flex flex-col gap-3 p-4 outline-none sm:right-0 sm:left-auto sm:w-96" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}
