/** @cb/design-tokens: tokens.json, the single source of design tokens; emits theme.css, Tokens.kt and icons. */
export const packageName = "@cb/design-tokens";

export { RESET_NAMESPACES, renderThemeCss } from "./css";
export { ANDROID_DRAWABLE_DIR, renderVectorDrawable } from "./icons/android";
export {
  androidDrawableName,
  ICON_NAME,
  type IconManifest,
  IconManifestError,
  parseIconManifest,
} from "./icons/manifest";
export {
  androidDrawablePath,
  LUCIDE_LICENSE_PATH,
  type LucideData,
  renderIconOutputs,
} from "./icons/outputs";
export { REACT_ICONS_PATH, renderReactIcons } from "./icons/react";
export {
  elementToPath,
  IconConversionError,
  type IconElement,
  type IconNode,
  LUCIDE_SVG,
  normalizePathData,
} from "./icons/svg";
export { KOTLIN_PACKAGE, renderTokensKt } from "./kotlin";
export { type GeneratedFile, OUTPUT_PATHS, renderOutputs } from "./outputs";
export {
  parseTokens,
  REQUIRED_TOKENS,
  type Tokens,
  TokenValidationError,
  tokensSchema,
} from "./schema";
export * from "./transform";
