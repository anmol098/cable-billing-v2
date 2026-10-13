/** @cb/db: Drizzle schema, migrations and RLS policies for Neon Postgres. See README.md. */
export const packageName = "@cb/db";

export {
  type CreateDbOptions,
  createDb,
  type DbClient,
  type DbDriver,
  resolveDriver,
} from "./client";
export {
  createUuidV7Generator,
  isUuid,
  isUuidV7,
  primaryId,
  type UuidV7GeneratorOptions,
  uuidV7Timestamp,
  uuidv7,
} from "./ids";
export {
  APP_PLATFORM_ROLE,
  APP_RW_ROLE,
  appPlatform,
  appRw,
  currentOperator,
  OPERATOR_ID_SETTING,
  operatorIdColumn,
  tenantKey,
  tenantPolicies,
} from "./rls";
export {
  checkRuntimeRole,
  MAX_LISTED_OBJECTS,
  type OwnedObject,
  type RuntimeRoleIssue,
  type RuntimeRoleIssueCode,
  type RuntimeRoleReport,
} from "./runtime-role";
export * from "./schema";
export { type Schema, TransactionFinishedError, type Tx, type TxOptions } from "./tenant";
export {
  type AppendOnlyTriggerOptions,
  appendOnlyTriggerSql,
  IMMUTABLE_ROW_SQLSTATE,
  isImmutableRowError,
  sqlStateOf,
} from "./triggers";
