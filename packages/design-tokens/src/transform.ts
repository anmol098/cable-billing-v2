/** Pure value transforms shared by the CSS and Kotlin generators. */

/** Browser default root font size: 1rem = 16px. */
export const REM_BASE_PX = 16;

/** Prints a number without float noise or trailing zeros: 0.875, 4, 624.9375. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`not a finite number: ${value}`);
  return String(Number(value.toFixed(4)));
}

/** px → rem string for CSS, e.g. 14 → "0.875rem". */
export function pxToRem(px: number): string {
  return `${formatNumber(px / REM_BASE_PX)}rem`;
}

/** px → px string for CSS, e.g. 1 → "1px". */
export function pxToCss(px: number): string {
  return `${formatNumber(px)}px`;
}

/** Kotlin Compose `Dp` literal, e.g. 8 → "8.dp". */
export function dp(value: number): string {
  return `${formatNumber(value)}.dp`;
}

/** Kotlin Compose `TextUnit` literal, e.g. 18 → "18.sp". */
export function sp(value: number): string {
  return `${formatNumber(value)}.sp`;
}

const HEX = /^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

/** Normalises a token colour for CSS: upper-case `#RRGGBB` / `#RRGGBBAA`. */
export function hexToCss(hex: string): string {
  if (!HEX.test(hex)) throw new Error(`not a hex colour: ${hex}`);
  return hex.toUpperCase();
}

/** `#RRGGBB` → `0xFFRRGGBB`, `#RRGGBBAA` → `0xAARRGGBB` (Compose ARGB order). */
export function hexToArgb(hex: string): string {
  const css = hexToCss(hex).slice(1);
  const rgb = css.slice(0, 6);
  const alpha = css.length === 8 ? css.slice(6) : "FF";
  return `0x${alpha}${rgb}`;
}

/** `#15803D` → `Color(0xFF15803D)`. `colorFn` lets the caller use an import alias. */
export function hexToComposeColor(hex: string, colorFn = "Color"): string {
  return `${colorFn}(${hexToArgb(hex)})`;
}

/** Token name → CSS name: `textMuted` → `text-muted`, `2xl` → `2xl`. */
export function kebabCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** Token name → Kotlin name: `textMuted` → `TextMuted`, `2xl` → `Xxl`, `3xl` → `Xxxl`. */
export function pascalCase(name: string): string {
  const scale = /^([2-9])xl$/.exec(name);
  const base = scale ? `${"x".repeat(Number(scale[1]))}l` : name;
  if (!/^[a-z][a-zA-Z0-9]*$/.test(base)) {
    throw new Error(`cannot make a Kotlin name from "${name}"`);
  }
  return base.charAt(0).toUpperCase() + base.slice(1);
}

const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
]);

/** Font family list → CSS: `Inter, "Noto Sans Devanagari", system-ui, sans-serif`. */
export function cssFontFamily(families: readonly string[]): string {
  return families
    .map((family) =>
      GENERIC_FAMILIES.has(family) || /^[A-Za-z][A-Za-z0-9-]*$/.test(family)
        ? family
        : `"${family}"`,
    )
    .join(", ");
}

/** OpenType features → CSS `font-feature-settings`: `"tnum", "lnum"`. */
export function cssFontFeatures(features: readonly string[]): string {
  return features.map((feature) => `"${feature}"`).join(", ");
}

/** OpenType features → Compose `fontFeatureSettings` (Android CSS-like syntax): `'tnum', 'lnum'`. */
export function composeFontFeatures(features: readonly string[]): string {
  return features.map((feature) => `'${feature}'`).join(", ");
}

/** A Kotlin string literal. */
export function kotlinString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$")}"`;
}
