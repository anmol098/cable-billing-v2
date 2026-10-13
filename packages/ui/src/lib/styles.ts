/*
 * Class strings shared by the primitives. Token utilities only (theme.css); the tokens-only test
 * scans this folder too.
 */

/**
 * Keyboard focus ring in the `focus` token colour. The width and offset use Tailwind's numeric
 * outline scale (2 = the `border.strong` token value): tokens.json has no outline-width token and
 * the generated border utilities set `border-width`, not `outline-width`.
 */
export const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** Same ring for a wrapper whose inner control has focus (AmountInput). */
export const focusWithinRing =
  "has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus";

/** Text fields and selects: full width, at least the touch-min height, hairline border. */
export const fieldBase = [
  "block w-full min-h-touch-min rounded-md border-hairline border-border bg-bg px-3",
  "font-sans text-base text-text placeholder:text-text-muted",
  "aria-invalid:border-danger",
  "disabled:cursor-not-allowed disabled:bg-surface disabled:text-text-muted",
  focusRing,
].join(" ");
