import { z } from "zod";

/**
 * Token names every consumer relies on. The build fails if one is missing.
 * Extra names are allowed and flow through to both platforms.
 */
export const REQUIRED_TOKENS = {
  color: ["bg", "surface", "text", "textMuted", "border", "accent", "onAccent", "focus"],
  semantic: ["cash", "upi", "pending", "success", "danger", "due", "credit"],
  fontFamily: ["sans", "numeric"],
  fontWeight: ["regular", "strong"],
  type: ["sm", "base", "lg", "xl", "2xl", "amount"],
  radius: ["none", "sm", "md", "lg", "full"],
  border: ["hairline", "strong"],
  size: ["touchMin", "primaryButton"],
  elevation: ["none"],
} as const;

/** camelCase: `textMuted`, `touchMin`. Becomes kebab-case in CSS and PascalCase in Kotlin. */
const NAME = /^[a-z][a-zA-Z0-9]*$/;
/** Type scale steps may also be `2xl`, `3xl`, … (Tailwind style). */
const SCALE_NAME = /^(?:[a-z][a-zA-Z0-9]*|[2-9]xl)$/;
const HEX = /^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;
/** A font family name: letters, digits, spaces and hyphens (`Noto Sans Devanagari`, `system-ui`). */
const FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9 -]*$/;
/** An OpenType feature tag such as `tnum`. */
const FEATURE = /^[a-z0-9]{4}$/;

const nameKey = (pattern: RegExp) =>
  z
    .string()
    .regex(
      pattern,
      pattern === NAME
        ? "token names must be camelCase (start with a lowercase letter; letters and digits only)"
        : "type scale names must be camelCase or 2xl…9xl",
    );

/** A group of named tokens: `{ name: value }`, with some names required. */
function group<T extends z.ZodType>(value: T, required: readonly string[], pattern: RegExp = NAME) {
  return z.record(nameKey(pattern), value).superRefine((tokens, ctx) => {
    for (const name of required) {
      if (!Object.hasOwn(tokens, name)) {
        ctx.addIssue({ code: "custom", path: [name], message: `missing required token "${name}"` });
      }
    }
  });
}

/** A length in px (web) or dp/sp (Android). */
const length = z.number().nonnegative("must be a number, 0 or more");
const positiveLength = z.number().positive("must be a number greater than 0");

const colorToken = z.strictObject({
  value: z.string().regex(HEX, "must be a hex colour: #RRGGBB or #RRGGBBAA"),
});

const fontFamilyToken = z.strictObject({
  value: z
    .array(z.string().regex(FONT_NAME, "font names may use letters, digits, spaces and hyphens"))
    .min(1, "list at least one font"),
  features: z
    .array(z.string().regex(FEATURE, "OpenType feature tags are 4 characters, e.g. tnum"))
    .optional(),
});

const fontWeightToken = z.strictObject({
  value: z.number().int().min(100).max(900).multipleOf(100, "font weights are 100, 200, … 900"),
});

const typeScale = group(positiveLength, REQUIRED_TOKENS.type, SCALE_NAME);

const sizeToken = z.strictObject({ web: positiveLength, android: positiveLength });

export const tokensSchema = z
  .strictObject({
    color: group(colorToken, REQUIRED_TOKENS.color),
    semantic: group(colorToken, REQUIRED_TOKENS.semantic),
    font: z.strictObject({
      family: group(fontFamilyToken, REQUIRED_TOKENS.fontFamily),
      weight: group(fontWeightToken, REQUIRED_TOKENS.fontWeight),
    }),
    type: z.strictObject({ web: typeScale, android: typeScale }),
    radius: group(length, REQUIRED_TOKENS.radius),
    border: group(positiveLength, REQUIRED_TOKENS.border),
    space: z.strictObject({ base: positiveLength }),
    size: group(sizeToken, REQUIRED_TOKENS.size),
    elevation: group(length, REQUIRED_TOKENS.elevation),
  })
  .superRefine((tokens, ctx) => {
    // `color` and `semantic` share one namespace on both platforms (`--color-*`, `Tokens.Color`).
    for (const name of Object.keys(tokens.semantic)) {
      if (Object.hasOwn(tokens.color, name)) {
        ctx.addIssue({
          code: "custom",
          path: ["semantic", name],
          message: `"${name}" is defined in both color and semantic`,
        });
      }
    }
    // Tailwind resolves `text-<name>` as a colour or a font size, so the names must differ.
    for (const name of [...Object.keys(tokens.color), ...Object.keys(tokens.semantic)]) {
      if (Object.hasOwn(tokens.type.web, name)) {
        ctx.addIssue({
          code: "custom",
          path: ["type", "web", name],
          message: `"${name}" is both a colour and a type size (text-${name} would be ambiguous)`,
        });
      }
    }
    // Both platforms must offer the same type steps.
    const web = Object.keys(tokens.type.web);
    const android = Object.keys(tokens.type.android);
    for (const name of web.filter((n) => !android.includes(n))) {
      ctx.addIssue({
        code: "custom",
        path: ["type", "android", name],
        message: `type step "${name}" exists for web but not android`,
      });
    }
    for (const name of android.filter((n) => !web.includes(n))) {
      ctx.addIssue({
        code: "custom",
        path: ["type", "web", name],
        message: `type step "${name}" exists for android but not web`,
      });
    }
  });

export type Tokens = z.infer<typeof tokensSchema>;

export class TokenValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`tokens.json is invalid:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "TokenValidationError";
    this.issues = issues;
  }
}

/** Validates raw tokens (the parsed tokens.json). Throws a readable error listing every problem. */
export function parseTokens(input: unknown): Tokens {
  const result = tokensSchema.safeParse(input);
  if (result.success) return result.data;
  throw new TokenValidationError(
    result.error.issues.map((issue) => {
      const path = issue.path.map(String).join(".");
      // A bad token name is reported as "Invalid key"; show why the key is invalid instead.
      const message =
        issue.code === "invalid_key"
          ? issue.issues.map((inner) => inner.message).join("; ")
          : issue.message;
      return path ? `${path}: ${message}` : message;
    }),
  );
}
