"use client";

import * as Popover from "@radix-ui/react-popover";
import { cn } from "../lib/cn";
import { focusRing } from "../lib/styles";

export type HelpTipProps = {
  /** Accessible name of the "?" button, e.g. "Help: Due" (an i18n string naming the topic). */
  label: string;
  /** One plain sentence in the page's language. */
  text: string;
  /** The same sentence in the other language (bilingual help, PLAN §12.2). */
  translation?: { text: string; lang: string };
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
};

/**
 * A round "?" button that opens one sentence of help (and its translation). Opens on tap, click
 * or Enter, never on hover only; Escape or a tap elsewhere closes it.
 */
export function HelpTip({ label, text, translation, side = "top", className }: HelpTipProps) {
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={label}
        className={cn(
          "inline-flex size-touch-min shrink-0 cursor-pointer items-center justify-center rounded-full",
          "text-text hover:bg-surface",
          focusRing,
          className,
        )}
      >
        {/* The symbol is universal; the accessible name comes from `label`. */}
        <span
          aria-hidden
          className="inline-flex size-6 items-center justify-center rounded-full border-strong border-current font-strong text-sm"
        >
          ?
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={side}
          // The margin keeps the bubble off the screen edge (Radix measures it as part of the box).
          className="z-50 mx-4 my-1 flex w-72 flex-col gap-2 rounded-md border-hairline border-border bg-bg p-4 text-text outline-none"
        >
          <p className="text-base">{text}</p>
          {translation ? (
            <p lang={translation.lang} className="text-base text-text-muted">
              {translation.text}
            </p>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
