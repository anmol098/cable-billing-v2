/**
 * `@cb/db/seed`: fake data for dev, previews and load tests (T-036). See cli.ts for `pnpm db:seed`.
 * Never import this from app code: seed data must never reach production (guard.ts).
 */
export { datasetCounts, datasetHash, type SeedDataset } from "./dataset";
export {
  fakePhone,
  type GeneratedOperator,
  type GenerateOptions,
  generateOperator,
  type OperatorSpec,
  type SeedLogin,
} from "./generate";
export { checkSeedTarget, type SeedTargetCheck } from "./guard";
export { Rng } from "./random";
export {
  isSeedScale,
  SCALE_CONFIGS,
  type ScaleConfig,
  SEED_SCALES,
  type SeedScale,
} from "./scales";
export {
  generateSeed,
  planOperators,
  SEED_DEV_PASSWORD,
  SEED_DEV_PASSWORD_HASH,
  type SeedOptions,
  SeedRefusedError,
  type SeedResult,
  seedDatabase,
} from "./seed";
export { type LedgerSampleReport, readLedgerState, verifyLedgerSample } from "./verify";
