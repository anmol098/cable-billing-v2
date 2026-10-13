/**
 * Lucide icon data → Android `pathData`.
 *
 * Lucide icons are 24×24 outlines: every element is stroked with `currentColor`, stroke width 2,
 * round caps and joins, no fill. A few elements (small dots) also set `fill="currentColor"`.
 * VectorDrawable only has `<path>`, so every SVG shape (circle, ellipse, rect with rounded corners,
 * line, polyline, polygon) is converted to path data here. Anything this module does not understand
 * throws, so a Lucide upgrade that uses new SVG features fails the build instead of drawing wrong.
 */

/** One SVG element as Lucide's `icon-nodes.json` stores it: `["circle", { "cx": "12", … }]`. */
export type IconElement = readonly [tag: string, attributes: Readonly<Record<string, string>>];
/** A whole icon: its elements in drawing order. */
export type IconNode = readonly IconElement[];

/** The SVG attributes Lucide sets on the `<svg>` root of every icon. */
export const LUCIDE_SVG = {
  size: 24,
  viewBox: "0 0 24 24",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** Shape attributes per element (besides `fill`). Any other attribute is an error. */
const SHAPE_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  path: ["d"],
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  rect: ["x", "y", "width", "height", "rx", "ry"],
  line: ["x1", "y1", "x2", "y2"],
  polyline: ["points"],
  polygon: ["points"],
};

export const SUPPORTED_ELEMENTS = Object.keys(SHAPE_ATTRIBUTES);

/** A converted element: path data plus whether it is filled (it is always stroked). */
export type VectorPath = { pathData: string; filled: boolean };

export class IconConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IconConversionError";
  }
}

/** Formats a coordinate: at most 4 decimals, no trailing zeros, no `-0`. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new IconConversionError(`not a finite number: ${value}`);
  const rounded = Math.round(value * 10_000) / 10_000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function parseNumber(raw: string, what: string): number {
  const text = raw.trim();
  if (!NUMBER.test(text)) throw new IconConversionError(`${what}: not a plain number: "${raw}"`);
  return Number(text);
}

/** Path command → number of arguments per repetition. */
const ARG_COUNT: Readonly<Record<string, number>> = {
  m: 2,
  l: 2,
  h: 1,
  v: 1,
  c: 6,
  s: 4,
  q: 4,
  t: 2,
  a: 7,
  z: 0,
};

/**
 * Re-serialises SVG path data in an explicit form every parser reads the same way: one command letter
 * per segment, arguments separated by spaces, arc flags as separate `0`/`1` tokens, numbers rounded
 * to 4 decimals. Lucide's minified paths (`a2 2 0 0 1-2 2`, `M6 12h.01`) become `a2 2 0 0 1 -2 2`,
 * `M6 12 h0.01`. Throws on anything that is not valid path data.
 */
export function normalizePathData(d: string): string {
  const out: string[] = [];
  let i = 0;
  let command = "";
  let segments = 0;

  const skipSeparators = () => {
    while (i < d.length && /[\s,]/.test(d.charAt(i))) i++;
  };
  const readNumber = (): number => {
    const match = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
    match.lastIndex = i;
    const found = match.exec(d);
    if (!found) throw new IconConversionError(`path "${d}": expected a number at ${i}`);
    i = match.lastIndex;
    return Number(found[0]);
  };
  const readFlag = (): number => {
    const char = d.charAt(i);
    if (char !== "0" && char !== "1") {
      throw new IconConversionError(`path "${d}": expected an arc flag (0 or 1) at ${i}`);
    }
    i++;
    return Number(char);
  };

  skipSeparators();
  while (i < d.length) {
    const char = d.charAt(i);
    if (/[a-zA-Z]/.test(char)) {
      if (ARG_COUNT[char.toLowerCase()] === undefined) {
        throw new IconConversionError(`path "${d}": unknown command "${char}"`);
      }
      command = char;
      i++;
    } else if (command === "") {
      throw new IconConversionError(`path "${d}": must start with a command`);
    } else if (command === "z" || command === "Z") {
      throw new IconConversionError(`path "${d}": numbers after "${command}"`);
    } else if (command === "M") {
      command = "L"; // extra pairs after a moveto are linetos
    } else if (command === "m") {
      command = "l";
    }

    const count = ARG_COUNT[command.toLowerCase()] ?? 0;
    const args: string[] = [];
    for (let n = 0; n < count; n++) {
      skipSeparators();
      const isFlag = command.toLowerCase() === "a" && (n === 3 || n === 4);
      args.push(formatNumber(isFlag ? readFlag() : readNumber()));
    }
    if (segments === 0 && command.toLowerCase() !== "m") {
      throw new IconConversionError(`path "${d}": must start with M or m`);
    }
    out.push(args.length > 0 ? `${command}${args.join(" ")}` : command);
    segments++;
    skipSeparators();
  }
  if (segments === 0) throw new IconConversionError("path data is empty");
  return out.join(" ");
}

function circlePath(cx: number, cy: number, rx: number, ry: number): string {
  const f = formatNumber;
  return [
    `M${f(cx - rx)} ${f(cy)}`,
    `a${f(rx)} ${f(ry)} 0 1 0 ${f(2 * rx)} 0`,
    `a${f(rx)} ${f(ry)} 0 1 0 ${f(-2 * rx)} 0`,
    "Z",
  ].join(" ");
}

/** SVG 2 `auto` rules: a missing radius copies the other one; both are capped at half the size. */
function cornerRadii(
  rx: number | undefined,
  ry: number | undefined,
  width: number,
  height: number,
): [number, number] {
  const x = rx ?? ry ?? 0;
  const y = ry ?? rx ?? 0;
  return [Math.min(x, width / 2), Math.min(y, height / 2)];
}

function rectPath(x: number, y: number, w: number, h: number, rx: number, ry: number): string {
  const f = formatNumber;
  if (rx <= 0 || ry <= 0) return `M${f(x)} ${f(y)} H${f(x + w)} V${f(y + h)} H${f(x)} Z`;
  const arc = (endX: number, endY: number) => `A${f(rx)} ${f(ry)} 0 0 1 ${f(endX)} ${f(endY)}`;
  return [
    `M${f(x + rx)} ${f(y)}`,
    `H${f(x + w - rx)}`,
    arc(x + w, y + ry),
    `V${f(y + h - ry)}`,
    arc(x + w - rx, y + h),
    `H${f(x + rx)}`,
    arc(x, y + h - ry),
    `V${f(y + ry)}`,
    arc(x + rx, y),
    "Z",
  ].join(" ");
}

function pointsPath(points: string, close: boolean, what: string): string {
  const values = points
    .trim()
    .split(/[\s,]+/)
    .filter((value) => value !== "")
    .map((value) => parseNumber(value, `${what} points`));
  if (values.length < 4 || values.length % 2 !== 0) {
    throw new IconConversionError(`${what}: points must be at least two x,y pairs: "${points}"`);
  }
  const pairs: string[] = [];
  for (let n = 0; n < values.length; n += 2) {
    pairs.push(`${formatNumber(values[n] ?? 0)} ${formatNumber(values[n + 1] ?? 0)}`);
  }
  const [first, ...rest] = pairs;
  return [`M${first}`, ...rest.map((pair) => `L${pair}`), ...(close ? ["Z"] : [])].join(" ");
}

/** Converts one Lucide element to VectorDrawable path data. */
export function elementToPath([tag, attributes]: IconElement): VectorPath {
  const allowed = SHAPE_ATTRIBUTES[tag];
  if (!allowed) {
    throw new IconConversionError(
      `unsupported element <${tag}> (supported: ${SUPPORTED_ELEMENTS.join(", ")})`,
    );
  }
  for (const name of Object.keys(attributes)) {
    if (name !== "fill" && !allowed.includes(name)) {
      throw new IconConversionError(`<${tag}>: unsupported attribute "${name}"`);
    }
  }
  const fill = attributes.fill ?? "none";
  if (fill !== "none" && fill !== "currentColor") {
    throw new IconConversionError(`<${tag}>: fill must be "none" or "currentColor", got "${fill}"`);
  }

  const what = `<${tag}>`;
  const required = (name: string) => {
    const raw = attributes[name];
    if (raw === undefined) throw new IconConversionError(`${what}: missing "${name}"`);
    return parseNumber(raw, `${what} ${name}`);
  };
  const optional = (name: string) => {
    const raw = attributes[name];
    return raw === undefined || raw === "auto" ? undefined : parseNumber(raw, `${what} ${name}`);
  };
  const positive = (name: string, value: number) => {
    if (value <= 0) throw new IconConversionError(`${what}: ${name} must be > 0, got ${value}`);
    return value;
  };

  let pathData: string;
  switch (tag) {
    case "path":
      pathData = normalizePathData(attributes.d ?? "");
      break;
    case "circle": {
      const r = positive("r", required("r"));
      pathData = circlePath(optional("cx") ?? 0, optional("cy") ?? 0, r, r);
      break;
    }
    case "ellipse": {
      const [rx, ry] = cornerRadii(optional("rx"), optional("ry"), Infinity, Infinity);
      pathData = circlePath(
        optional("cx") ?? 0,
        optional("cy") ?? 0,
        positive("rx", rx),
        positive("ry", ry),
      );
      break;
    }
    case "rect": {
      const width = positive("width", required("width"));
      const height = positive("height", required("height"));
      const [rx, ry] = cornerRadii(optional("rx"), optional("ry"), width, height);
      pathData = rectPath(optional("x") ?? 0, optional("y") ?? 0, width, height, rx, ry);
      break;
    }
    case "line": {
      const f = formatNumber;
      const [x1, y1, x2, y2] = ["x1", "y1", "x2", "y2"].map((name) => optional(name) ?? 0);
      pathData = `M${f(x1 ?? 0)} ${f(y1 ?? 0)} L${f(x2 ?? 0)} ${f(y2 ?? 0)}`;
      break;
    }
    default:
      pathData = pointsPath(attributes.points ?? "", tag === "polygon", what);
  }
  return { pathData, filled: fill === "currentColor" };
}
