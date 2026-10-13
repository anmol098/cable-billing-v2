/**
 * @cb/migration: legacy MariaDB → Neon migration tooling (PLAN §15). T-090 delivers staging and
 * profiling; transforms (T-092/T-093) and reconciliation (T-094) build on the `legacy` schema.
 * How to run it: docs/migration/README.md.
 */
export * from "./config";
export {
  type CopyOptions,
  type CopyResult,
  copyLegacy,
  ensureLegacySchema,
  toPg,
} from "./copy/copy";
export { type ColumnKind, pgColumnType, quotePgIdent } from "./copy/types";
export { mysqlLiteral, toMysqlDump } from "./fixture/dump";
export {
  FIXTURE_SCALES,
  type Fixture,
  type FixtureScale,
  generateFixture,
} from "./fixture/generate";
export { collectForbiddenValues } from "./pii/forbidden";
export {
  describeFindings,
  ForbiddenValues,
  normalizeForMatch,
  type PiiFinding,
  scanForPii,
  shapeFindings,
} from "./pii/scan";
export { type Catalog, findColumn, findTable, readCatalog } from "./profile/catalog";
export { classifyColumn, columnWords } from "./profile/classify";
export { collectProfile, istDate } from "./profile/collect";
export { renderProfile } from "./profile/render";
export { type ProfileRun, runProfile } from "./profile/run";
export type * from "./profile/types";
export { DEFAULT_LEGACY_DB_URL, MariaDbSource, quoteMysqlIdent } from "./source/mariadb";
export { MemorySource, type MemoryTable } from "./source/memory";
export type { LegacyColumn, LegacySource, LegacyTable, LegacyValue } from "./source/types";
export {
  assertTargetDeclaredNonProd,
  checkTarget,
  TARGET_MARKER_SETTING,
  TARGET_MARKER_VALUE,
  type TargetCheck,
} from "./target";
