"use client";

import * as Popover from "@radix-ui/react-popover";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Icon } from "../icons";
import { cn } from "../lib/cn";
import { fieldBase } from "../lib/styles";
import { Spinner } from "../primitives/Spinner";
import { VisuallyHidden } from "../primitives/VisuallyHidden";

export type ComboboxOption = {
  /** The id submitted / returned (e.g. a customer id). */
  value: string;
  /** What the person sees and what the field shows once chosen (e.g. "Ramesh Kumar"). */
  label: string;
  /** A second line that tells similar names apart (code, phone, area). */
  description?: string;
};

export type ComboboxProps = {
  /** Visible label above the field (an i18n string), e.g. "Find customer". */
  label: string;
  /** Hide the label visually (it stays the accessible name). Only when the page says it already. */
  hideLabel?: boolean;
  /** Example text in the empty field, e.g. "Name, phone or VC number". */
  placeholder?: string;
  /**
   * Fetches matches for the typed text (server action or fetch). Called after the person stops
   * typing for `debounceMs`; the signal aborts when they type again, and stale answers are ignored.
   */
  loadOptions: (query: string, signal: AbortSignal) => Promise<readonly ComboboxOption[]>;
  /** The chosen option. */
  onSelect: (option: ComboboxOption) => void;
  /** Controlled choice: the field shows its label. */
  value?: ComboboxOption | null;
  /** Characters needed before searching. Default 1. */
  minQueryLength?: number;
  /** Default 250 ms. */
  debounceMs?: number;
  /** "Searching…" */
  loadingLabel: string;
  /** "No customer found" */
  emptyLabel: string;
  /** "Could not search. Try again." */
  errorLabel: string;
  /** Screen-reader count, e.g. "3 results" (an ICU plural). */
  resultsLabel?: (count: number) => string;
  /** Submit the chosen value with a form under this name (hidden input). */
  name?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
};

type Status = "idle" | "loading" | "done" | "error";

/**
 * A search field with a list of matches (async). Type → matches appear below → arrow keys or tap
 * to choose. ARIA 1.2 combobox: focus stays in the field, the highlighted option is announced
 * with `aria-activedescendant`, and a status line says how many matches there are.
 */
export function Combobox({
  label,
  hideLabel = false,
  placeholder,
  loadOptions,
  onSelect,
  value,
  minQueryLength = 1,
  debounceMs = 250,
  loadingLabel,
  emptyLabel,
  errorLabel,
  resultsLabel,
  name,
  id,
  disabled,
  className,
}: ComboboxProps) {
  const autoId = useId();
  const inputId = id ?? `${autoId}-input`;
  const listId = `${autoId}-list`;
  const [query, setQuery] = useState(value?.label ?? "");
  const [chosen, setChosen] = useState<ComboboxOption | null>(value ?? null);
  const [options, setOptions] = useState<readonly ComboboxOption[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const anchor = useRef<HTMLDivElement>(null);
  const loader = useRef(loadOptions);
  loader.current = loadOptions;

  // A controlled `value` replaces what the field shows.
  useEffect(() => {
    if (value === undefined) return;
    setChosen(value);
    setQuery(value?.label ?? "");
  }, [value]);

  // Search after a pause in typing; abort the previous request.
  const searchText = chosen && query === chosen.label ? "" : query.trim();
  useEffect(() => {
    if (searchText.length < minQueryLength) {
      setStatus("idle");
      setOptions([]);
      return;
    }
    const controller = new AbortController();
    setStatus("loading");
    const timer = setTimeout(() => {
      loader.current(searchText, controller.signal).then(
        (found) => {
          if (controller.signal.aborted) return;
          setOptions(found);
          setActive(found.length > 0 ? 0 : -1);
          setStatus("done");
        },
        () => {
          if (!controller.signal.aborted) setStatus("error");
        },
      );
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searchText, minQueryLength, debounceMs]);

  const choose = (option: ComboboxOption) => {
    setChosen(option);
    setQuery(option.label);
    setOpen(false);
    setActive(-1);
    onSelect(option);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open && searchText.length >= minQueryLength) setOpen(true);
      if (options.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + step + options.length) % options.length);
    } else if (event.key === "Enter") {
      const option = open ? options[active] : undefined;
      if (option) {
        event.preventDefault();
        choose(option);
      }
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  };

  const showList = open && status !== "idle";
  const activeId = showList && active >= 0 ? `${listId}-${active}` : undefined;
  const statusText =
    status === "loading"
      ? loadingLabel
      : status === "error"
        ? errorLabel
        : status === "done"
          ? options.length === 0
            ? emptyLabel
            : (resultsLabel?.(options.length) ?? "")
          : "";

  return (
    <div className={cn("flex flex-col gap-2", className)} data-slot="combobox">
      <label
        htmlFor={inputId}
        className={cn("font-strong text-base text-text", hideLabel && "sr-only")}
      >
        {label}
      </label>
      <Popover.Root open={showList} onOpenChange={setOpen}>
        <Popover.Anchor asChild>
          <div ref={anchor} className="relative">
            <Icon
              name="search"
              className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-text-muted"
            />
            <input
              id={inputId}
              type="text"
              role="combobox"
              autoComplete="off"
              aria-autocomplete="list"
              aria-expanded={showList}
              aria-controls={showList ? listId : undefined}
              aria-activedescendant={activeId}
              placeholder={placeholder}
              disabled={disabled}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setChosen(null);
                setOpen(true);
              }}
              onFocus={() => {
                if (searchText.length >= minQueryLength) setOpen(true);
              }}
              onKeyDown={onKeyDown}
              className={cn(fieldBase, "pr-10 pl-10")}
            />
            {status === "loading" ? (
              <Spinner className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-text-muted" />
            ) : null}
          </div>
        </Popover.Anchor>
        <Popover.Portal>
          <Popover.Content
            align="start"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onInteractOutside={(event) => {
              // Taps in the field itself keep the list open.
              if (anchor.current?.contains(event.target as Node)) event.preventDefault();
            }}
            className="z-50 my-1 max-h-72 w-(--radix-popover-trigger-width) overflow-y-auto rounded-md border-hairline border-border bg-bg p-1 text-text outline-none"
          >
            {status === "done" && options.length > 0 ? null : (
              <p className="px-3 py-3 text-base text-text-muted">{statusText}</p>
            )}
            <div id={listId} role="listbox" aria-label={label}>
              {options.map((option, index) => (
                // Keyboard choice happens in the field (arrow keys + Enter, aria-activedescendant),
                // so the option itself only needs pointer handlers.
                // biome-ignore lint/a11y/useKeyWithClickEvents: see above.
                <div
                  key={option.value}
                  id={`${listId}-${index}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === active}
                  // Keep focus in the field when tapping an option.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(option)}
                  onMouseMove={() => setActive(index)}
                  className={cn(
                    "flex min-h-touch-min cursor-pointer flex-col justify-center rounded-sm px-3 py-2",
                    index === active && "bg-surface outline-2 -outline-offset-2 outline-focus",
                  )}
                >
                  <span className="text-base text-text">{option.label}</span>
                  {option.description ? (
                    <span className="text-sm text-text-muted">{option.description}</span>
                  ) : null}
                </div>
              ))}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <VisuallyHidden role="status">{showList ? statusText : ""}</VisuallyHidden>
      {name ? <input type="hidden" name={name} value={chosen?.value ?? ""} /> : null}
    </div>
  );
}
