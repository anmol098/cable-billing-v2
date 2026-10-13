"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Icon, type IconName } from "../icons";
import { cn } from "../lib/cn";
import { Button } from "../primitives/Button";

/** PLAN §12.2: at most 6 fields per step. The Stepper warns in development when a step has more. */
export const STEPPER_MAX_FIELDS = 6;

export type StepperStep = {
  /** Stable id (React key, `data-step`). */
  id: string;
  /** Short name of the step (an i18n string): "Customer", "Connections", "Check & save". */
  title: string;
  /** The step's fields. Every step stays mounted (hidden when not current), so one surrounding
   * `<form>` submits all of them at the end. */
  content: ReactNode;
};

export type StepperProps = {
  steps: readonly StepperStep[];
  /** Controlled current step (0-based). */
  step?: number;
  /** Uncontrolled start step. Default 0. */
  defaultStep?: number;
  onStepChange?: (step: number) => void;
  /** `common.back` */
  backLabel: string;
  /** `common.next` */
  nextLabel: string;
  /** The last button's word, e.g. `common.save`. */
  finishLabel: string;
  finishIcon?: IconName;
  /** "Step 2 of 3" from an i18n message with `{current}` and `{total}`. */
  progressLabel: (current: number, total: number) => string;
  /**
   * Runs when Next is pressed, after the browser's own checks (`required`, `pattern`, …) of the
   * step's fields pass. Return `false` to stay on the step (show what is wrong inside it).
   */
  onNext?: (step: number) => boolean | Promise<boolean>;
  /**
   * `submit` (default): the last button is a submit button for the surrounding `<form>` (a server
   * action receives every step's fields). `button`: it calls `onFinish` instead.
   */
  finishType?: "submit" | "button";
  onFinish?: () => void | Promise<void>;
  /** Shows the last button as busy (e.g. `useFormStatus().pending`). */
  finishing?: boolean;
  /** Word on the last button while busy, e.g. "Saving…". */
  finishingLabel?: string;
  /** Level of each step's heading. Default 2 (under the page's h1); 3 inside a titled section. */
  headingLevel?: 2 | 3;
  className?: string;
};

const FIELD_SELECTOR = [
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([aria-hidden="true"])',
  "select",
  "textarea",
  '[role="radiogroup"]',
].join(", ");

/**
 * How many fields a person fills in on this step: each input, select and textarea, a radio
 * group counted once (native radios by name, Radix groups by role).
 */
export function countStepFields(panel: ParentNode): number {
  const seen = new Set<string>();
  let count = 0;
  for (const element of panel.querySelectorAll(FIELD_SELECTOR)) {
    if (element.closest('[role="radiogroup"]') && element.getAttribute("role") !== "radiogroup") {
      continue;
    }
    if (element instanceof HTMLInputElement && element.type === "radio" && element.name) {
      if (seen.has(element.name)) continue;
      seen.add(element.name);
    }
    count += 1;
  }
  return count;
}

type Validatable = Element & { checkValidity(): boolean; reportValidity(): boolean };

function isValidatable(element: Element): element is Validatable {
  return "checkValidity" in element && "reportValidity" in element;
}

/** Runs the browser's constraint checks on a step; shows the first problem. */
function validatePanel(panel: HTMLElement | null): boolean {
  if (!panel) return true;
  for (const element of panel.querySelectorAll("input, select, textarea")) {
    if (isValidatable(element) && !element.checkValidity()) {
      element.reportValidity();
      return false;
    }
  }
  return true;
}

/**
 * The shell for a multi-step form (PLAN §12.2: e.g. Customer → Connections → Check & save): a
 * progress list, one step's fields at a time, Back and Next, and Save on the last step. Focus
 * moves to the new step's heading so screen readers announce it.
 */
export function Stepper({
  steps,
  step: stepProp,
  defaultStep = 0,
  onStepChange,
  backLabel,
  nextLabel,
  finishLabel,
  finishIcon = "success",
  progressLabel,
  onNext,
  finishType = "submit",
  onFinish,
  finishing = false,
  finishingLabel,
  headingLevel = 2,
  className,
}: StepperProps) {
  const [stepState, setStepState] = useState(defaultStep);
  const [checking, setChecking] = useState(false);
  const [finishingState, setFinishingState] = useState(false);
  const current = Math.min(Math.max(stepProp ?? stepState, 0), steps.length - 1);
  const baseId = useId();
  const panels = useRef<(HTMLElement | null)[]>([]);
  const headings = useRef<(HTMLHeadingElement | null)[]>([]);
  const moved = useRef(false);
  const last = current === steps.length - 1;
  const Heading = headingLevel === 3 ? "h3" : "h2";

  const goTo = (next: number) => {
    moved.current = true;
    if (stepProp === undefined) setStepState(next);
    onStepChange?.(next);
  };

  // After Back/Next, move focus to the new step's heading (not on first render).
  useEffect(() => {
    if (moved.current) headings.current[current]?.focus();
  }, [current]);

  // Development guidance: more than 6 fields on one step should be split (PLAN §12.2).
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const panel = panels.current[current];
    const count = panel ? countStepFields(panel) : 0;
    if (count > STEPPER_MAX_FIELDS) {
      console.warn(
        `Stepper step "${steps[current]?.id}" has ${count} fields; keep it to ${STEPPER_MAX_FIELDS} or fewer (PLAN §12.2).`,
      );
    }
  }, [current, steps]);

  const next = async () => {
    if (!validatePanel(panels.current[current] ?? null)) return;
    if (onNext) {
      setChecking(true);
      try {
        if ((await onNext(current)) === false) return;
      } finally {
        setChecking(false);
      }
    }
    goTo(current + 1);
  };

  const finish = async () => {
    if (!validatePanel(panels.current[current] ?? null)) return;
    if (!onFinish) return;
    setFinishingState(true);
    try {
      await onFinish();
    } finally {
      setFinishingState(false);
    }
  };

  return (
    <div className={cn("flex flex-col gap-6", className)} data-slot="stepper">
      <div className="flex flex-col gap-3">
        <p className="font-strong text-sm text-text-muted" aria-live="polite">
          {progressLabel(current + 1, steps.length)}
        </p>
        <ol className="hidden gap-4 sm:flex">
          {steps.map((item, index) => {
            const done = index < current;
            const active = index === current;
            return (
              <li
                key={item.id}
                aria-current={active ? "step" : undefined}
                className={cn(
                  "flex items-center gap-2 text-base",
                  active ? "font-strong text-text" : "text-text-muted",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "inline-flex size-8 shrink-0 items-center justify-center rounded-full border-hairline font-numeric text-sm",
                    active && "border-accent bg-accent text-on-accent",
                    done && "border-success text-success",
                    !active && !done && "border-border",
                  )}
                >
                  {done ? <Icon name="success" className="size-5" /> : index + 1}
                </span>
                {item.title}
              </li>
            );
          })}
        </ol>
      </div>

      {steps.map((item, index) => (
        <section
          key={item.id}
          ref={(element) => {
            panels.current[index] = element;
          }}
          hidden={index !== current}
          aria-labelledby={`${baseId}-${item.id}`}
          data-step={item.id}
          className="flex flex-col gap-4"
        >
          <Heading
            id={`${baseId}-${item.id}`}
            tabIndex={-1}
            ref={(element) => {
              headings.current[index] = element;
            }}
            className="font-strong text-xl text-text outline-none"
          >
            {item.title}
          </Heading>
          {item.content}
        </section>
      ))}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        {current > 0 ? (
          <Button
            variant="secondary"
            size="lg"
            icon="back"
            onClick={() => goTo(current - 1)}
            disabled={checking || finishing || finishingState}
          >
            {backLabel}
          </Button>
        ) : (
          <span className="hidden sm:block" />
        )}
        {last ? (
          <Button
            key="finish"
            type={finishType === "submit" ? "submit" : "button"}
            size="lg"
            icon={finishIcon}
            loading={finishing || finishingState}
            loadingLabel={finishingLabel}
            onClick={(event) => {
              if (finishType === "submit") {
                if (!validatePanel(panels.current[current] ?? null)) event.preventDefault();
                return;
              }
              void finish();
            }}
          >
            {finishLabel}
          </Button>
        ) : (
          <Button key="next" size="lg" icon="next" loading={checking} onClick={() => void next()}>
            {nextLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
