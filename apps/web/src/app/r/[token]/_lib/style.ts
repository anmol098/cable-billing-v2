/**
 * The public receipt page's only stylesheet, inlined in the HTML (one small response, no extra
 * request, no JavaScript, no web fonts: low-end phones on slow data, PLAN §9.4).
 *
 * Every colour, font, type size, radius, border width and spacing step comes from
 * `packages/design-tokens/tokens.json` (D-04), exposed as the same CSS variables the app's Tailwind
 * theme defines (`--color-cash`, `--text-amount`, `--spacing`, …). Hyper-minimal: no shadows, no
 * gradients. The only literal numbers are unitless ratios (line height) and spacing multiples.
 */
import tokens from "@cb/design-tokens/tokens.json";

const REM_BASE_PX = 16;
const rem = (px: number) => `${px / REM_BASE_PX}rem`;
const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const family = (names: readonly string[]) =>
  names.map((name) => (/\s/.test(name) ? `"${name}"` : name)).join(", ");

function variables(): string {
  const vars: string[] = [];
  const v = (name: string, value: string) => vars.push(`--${name}:${value}`);
  for (const [name, token] of Object.entries(tokens.color)) v(`color-${kebab(name)}`, token.value);
  for (const [name, token] of Object.entries(tokens.semantic))
    v(`color-${kebab(name)}`, token.value);
  for (const [name, token] of Object.entries(tokens.font.family)) {
    v(`font-${kebab(name)}`, family(token.value));
  }
  for (const [name, token] of Object.entries(tokens.font.weight)) {
    v(`font-weight-${kebab(name)}`, String(token.value));
  }
  for (const [name, px] of Object.entries(tokens.type.web)) v(`text-${kebab(name)}`, rem(px));
  for (const [name, px] of Object.entries(tokens.radius)) v(`radius-${kebab(name)}`, rem(px));
  for (const [name, px] of Object.entries(tokens.border)) v(`border-${kebab(name)}`, `${px}px`);
  v("spacing", rem(tokens.space.base));
  for (const [name, size] of Object.entries(tokens.size)) v(`size-${kebab(name)}`, rem(size.web));
  return `:root{${vars.join(";")}}`;
}

const s = (n: number) => `calc(var(--spacing)*${n})`;

const RULES = [
  "*{box-sizing:border-box}",
  "html{-webkit-text-size-adjust:100%}",
  "body{margin:0;background:var(--color-bg);color:var(--color-text);font-family:var(--font-sans);font-size:var(--text-base);font-weight:var(--font-weight-regular);line-height:1.5;overflow-wrap:anywhere}",
  `main{max-width:${s(120)};margin:0 auto;padding:${s(4)}}`,
  `.card{background:var(--color-surface);border:var(--border-hairline) solid var(--color-border);border-radius:var(--radius-lg);padding:${s(4)}}`,
  ".center{text-align:center}",
  "h1,h2,p{margin:0}",
  "h1{font-size:var(--text-xl);font-weight:var(--font-weight-strong)}",
  "h2{font-size:var(--text-lg);font-weight:var(--font-weight-strong)}",
  `.muted{color:var(--color-text-muted)}`,
  `.stack>*+*{margin-top:${s(2)}}`,
  `hr{border:0;border-top:var(--border-hairline) solid var(--color-border);margin:${s(4)} 0}`,
  "dl{margin:0}",
  `.field{display:flex;justify-content:space-between;gap:${s(4)};padding:${s(1)} 0}`,
  ".field dt{color:var(--color-text-muted)}",
  ".field dd{margin:0;min-width:0;text-align:right;font-weight:var(--font-weight-strong)}",
  '.num{font-family:var(--font-numeric);font-feature-settings:"tnum"}',
  `.amount{font-size:var(--text-amount);font-weight:var(--font-weight-strong);line-height:1.2}`,
  `.method{display:inline-flex;align-items:center;gap:${s(2)};font-weight:var(--font-weight-strong);font-size:var(--text-lg)}`,
  ".cash{color:var(--color-cash)}",
  ".upi{color:var(--color-upi)}",
  ".due{color:var(--color-due)}",
  ".credit{color:var(--color-credit)}",
  ".icon{width:var(--size-icon);height:var(--size-icon);flex:none}",
  ".icon-large{width:var(--size-icon-large);height:var(--size-icon-large);flex:none}",
  `.stamp{display:inline-block;border:var(--border-strong) solid var(--color-danger);color:var(--color-danger);border-radius:var(--radius-md);padding:${s(1)} ${s(4)};font-size:var(--text-xl);font-weight:var(--font-weight-strong)}`,
  ".danger{color:var(--color-danger)}",
  `.cancelled .amount{text-decoration:line-through}`,
  `.button{display:flex;align-items:center;justify-content:center;gap:${s(2)};min-height:var(--size-primary-button);margin-top:${s(4)};padding:0 ${s(4)};background:var(--color-accent);color:var(--color-on-accent);border-radius:var(--radius-md);font-weight:var(--font-weight-strong);text-decoration:none}`,
  `.call{display:inline-flex;align-items:center;gap:${s(2)};min-height:var(--size-touch-min);color:var(--color-text)}`,
  `nav{display:flex;align-items:center;justify-content:center;gap:${s(4)};margin-top:${s(4)}}`,
  `nav a{display:inline-flex;align-items:center;gap:${s(1)};min-height:var(--size-touch-min);padding:0 ${s(3)};color:var(--color-text)}`,
  'nav a[aria-current="true"]{font-weight:var(--font-weight-strong);text-decoration:none}',
  `a:focus-visible{outline:var(--border-strong) solid var(--color-focus);outline-offset:${s(0.5)}}`,
];

/** The complete inline stylesheet (built once per server instance). */
export const RECEIPT_PAGE_CSS = `${variables()}${RULES.join("")}`;
