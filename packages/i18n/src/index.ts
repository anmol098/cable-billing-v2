/**
 * @cb/i18n: English and Hindi message catalogues; emits web messages and Android strings.
 *
 * This entry is safe to import from browser code (no Node built-ins). The file loader lives in
 * `./load` and the CLI in `scripts/i18n.ts`.
 */
export const packageName = "@cb/i18n";

export {
  ANDROID_QUANTITIES,
  type AndroidArg,
  AndroidCompileError,
  type AndroidEntry,
  type AndroidValue,
  androidArgs,
  androidResourceName,
  compileAndroid,
  escapeAndroid,
  renderAndroidXml,
} from "./android";
export {
  buildAndroidEntries,
  buildWebMessages,
  type Catalog,
  type Issue,
  type MessageTree,
  type Namespace,
  type RawCatalog,
  stableJson,
  type ValidationResult,
  validateCatalog,
} from "./catalog";
export {
  ANDROID_RES_DIR,
  androidValuesDir,
  type GeneratedFile,
  generateFiles,
  WEB_MESSAGES_DIR,
} from "./generate";
export { type ArgKind, argSignature, parseMessage } from "./icu";
export {
  ANDROID_DEFAULT_LOCALE,
  isAndroidNamespace,
  LOCALES,
  type Locale,
  REVIEW_KEY,
  SOURCE_LOCALE,
  WEB_DEFAULT_LOCALE,
} from "./locales";
