import localFont from "next/font/local";

/**
 * Self-hosted fonts (PLAN §6.3) through `next/font/local`: the files come from the Fontsource
 * npm packages (SIL OFL 1.1), are copied into the build with hashed names and served from our
 * own origin. Nothing is fetched from Google at build or run time.
 *
 * Each face is registered under the exact family name the design tokens use
 * (`--font-sans: Inter, "Noto Sans Devanagari", …` in `@cb/ui/theme.css`), so the token stack
 * works as-is and no font name is repeated in app CSS. `unicode-range` lets the browser download
 * a subset only when the page contains its characters.
 *
 * Importing this module from the root layout is what adds the `@font-face` rules; the exports
 * exist only so the layout has something to reference.
 */

/** Basic Latin, punctuation, € and other common symbols. Preloaded: every page uses it. */
export const interLatin = localFont({
  src: "../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "Inter" },
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});

/**
 * Latin Extended (accented names): only pages that contain such a letter download it (≈85 KB).
 * The rupee sign (U+20B9) is cut out of its range: `₹` is on most pages, and comes from the small
 * face below instead.
 */
export const interLatinExt = localFont({
  src: "../../node_modules/@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "Inter" },
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20B8, U+20BA-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
});

/**
 * The rupee sign only (T-087a). `₹` is not in Inter's `latin` file, and the `latin-ext` file that
 * has it is ≈85 KB, which every page showing an amount paid for one glyph. This face takes `₹`
 * from Noto Sans Devanagari's small `latin-ext` file (≈14 KB, same OFL licence, variable weight)
 * and registers it as part of the `Inter` family, so both token stacks (`--font-sans` and
 * `--font-numeric`, which has no Devanagari face) pick it up with no CSS change.
 *
 * Noto draws `₹` 0.622 em tall (the Devanagari cap height); Inter's own `₹` and digits are
 * 0.728 em. `size-adjust` (0.728 / 0.622 ≈ 117 %) is a metric correction, not a design value: it
 * makes the sign exactly as tall as the digits next to it, as Inter's own sign was.
 */
export const interRupee = localFont({
  src: "../../node_modules/@fontsource-variable/noto-sans-devanagari/files/noto-sans-devanagari-latin-ext-wght-normal.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "Inter" },
    { prop: "unicode-range", value: "U+20B9" },
    { prop: "size-adjust", value: "117%" },
  ],
});

/**
 * Devanagari for Hindi. Not preloaded (≈120 KB): English pages never download it, and Hindi
 * pages fetch it as soon as the CSS sees Devanagari text (`font-display: swap`).
 */
export const notoSansDevanagari = localFont({
  src: "../../node_modules/@fontsource-variable/noto-sans-devanagari/files/noto-sans-devanagari-devanagari-wght-normal.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "Noto Sans Devanagari" },
    {
      prop: "unicode-range",
      value:
        "U+0900-097F, U+1CD0-1CF9, U+200C-200D, U+20A8, U+20B9, U+20F0, U+25CC, U+A830-A839, U+A8E0-A8FF, U+11B00-11B09",
    },
  ],
});
