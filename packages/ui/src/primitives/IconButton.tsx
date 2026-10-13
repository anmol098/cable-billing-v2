"use client";

import * as Tooltip from "@radix-ui/react-tooltip";
import type { ComponentProps } from "react";
import { Icon, type IconName } from "../icons";
import { cn } from "../lib/cn";
import { Button, type ButtonSize, type ButtonVariant, buttonClasses } from "./Button";
import { Spinner } from "./Spinner";

export type IconButtonProps = Omit<ComponentProps<"button">, "children" | "aria-label"> & {
  icon: IconName;
  /**
   * The word for this action (an i18n string). Always required: it is the visible word with
   * `showLabel`, otherwise the accessible name (`aria-label`) and the tooltip text.
   */
  label: string;
  /** Show the word next to the icon (preferred for low-literacy screens: icon + word). */
  showLabel?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Where the tooltip opens (icon-only mode). */
  tooltipSide?: "top" | "right" | "bottom" | "left";
};

const SQUARE: Record<ButtonSize, string> = {
  md: "size-touch-min px-0",
  lg: "size-primary-button px-0",
};

/**
 * A button whose main content is an icon. It always has a name: either the visible word
 * (`showLabel`) or `aria-label` plus a tooltip on hover/keyboard focus.
 */
export function IconButton({
  icon,
  label,
  showLabel = false,
  variant = "secondary",
  size = "md",
  loading = false,
  tooltipSide = "top",
  disabled,
  className,
  type,
  ...props
}: IconButtonProps) {
  if (showLabel) {
    return (
      <Button
        icon={icon}
        variant={variant}
        size={size}
        loading={loading}
        disabled={disabled}
        className={className}
        type={type}
        {...props}
      >
        {label}
      </Button>
    );
  }

  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type={type ?? "button"}
            aria-label={label}
            disabled={disabled || loading}
            aria-busy={loading || undefined}
            className={buttonClasses({
              variant,
              size,
              loading,
              className: cn(SQUARE[size], className),
            })}
            {...props}
          >
            {loading ? <Spinner size="md" /> : <Icon name={icon} className="size-6" />}
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          {/* The transparent padding is the gap between button and tooltip (token spacing). */}
          <Tooltip.Content side={tooltipSide} className="p-1">
            <span className="block rounded-md bg-text px-2 py-1 font-sans text-sm text-bg">
              {label}
            </span>
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
