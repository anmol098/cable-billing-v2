import type { ComponentProps } from "react";
import { cn } from "../lib/cn";
import { focusRing } from "../lib/styles";

export type LanguageSwitchOption = {
  /** The locale code submitted, e.g. `en`, `hi`. Also the button's `lang`. */
  value: string;
  /** The short form shown, in its own script: `EN`, `हिं`. */
  short: string;
  /** The full name in its own script (`English`, `हिंदी`): the button's accessible name. */
  name: string;
};

export type LanguageSwitchProps = Omit<ComponentProps<"form">, "action" | "children"> & {
  /** Usually two: English and Hindi. */
  options: readonly LanguageSwitchOption[];
  /** The locale the page is shown in; its button is pressed. */
  value: string;
  /** Accessible name of the switch, e.g. "Language" / "भाषा". */
  label: string;
  /**
   * Form action that receives `FormData` with `name` = the chosen locale: in apps/web, the
   * `setLocale` server action (cookie + re-render). Works without client JavaScript.
   */
  action: (formData: FormData) => void | Promise<void>;
  /** Field name for the chosen locale. Default `locale`. */
  name?: string;
};

/**
 * EN | हिं: the language switch, one tap away on every screen (PLAN §2.2 rule 10). Each language
 * is written in its own script. Presentational: the app passes its locale action.
 */
export function LanguageSwitch({
  options,
  value,
  label,
  action,
  name = "locale",
  className,
  ...props
}: LanguageSwitchProps) {
  return (
    <form
      action={action}
      aria-label={label}
      className={cn(
        "inline-flex items-stretch rounded-md border-hairline border-border bg-bg",
        className,
      )}
      {...props}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="submit"
            name={name}
            value={option.value}
            lang={option.value}
            aria-label={option.name}
            aria-pressed={selected}
            className={cn(
              "inline-flex min-h-touch-min min-w-touch-min cursor-pointer items-center justify-center px-3",
              "font-sans font-strong text-base",
              index > 0 && "border-l-hairline border-border",
              index === 0 && "rounded-l-md",
              index === options.length - 1 && "rounded-r-md",
              selected ? "bg-accent text-on-accent" : "bg-bg text-text hover:bg-surface",
              focusRing,
            )}
          >
            {option.short}
          </button>
        );
      })}
    </form>
  );
}
