import { renderThemeCss } from "./css";
import { renderTokensKt } from "./kotlin";
import type { Tokens } from "./schema";

/** Where the generated files live, relative to the repo root. Both are committed. */
export const OUTPUT_PATHS = {
  css: "packages/ui/src/theme.css",
  kotlin:
    "apps/android/core/designsystem/src/main/java/com/cablebilling/designsystem/generated/Tokens.kt",
} as const;

export type GeneratedFile = { path: string; content: string };

/** Every file generated from tokens.json. */
export function renderOutputs(tokens: Tokens): GeneratedFile[] {
  return [
    { path: OUTPUT_PATHS.css, content: renderThemeCss(tokens) },
    { path: OUTPUT_PATHS.kotlin, content: renderTokensKt(tokens) },
  ];
}
