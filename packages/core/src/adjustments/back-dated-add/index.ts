/**
 * The Owner's back-dated new connection (T-045a): a connection whose start day is in a month that
 * is already billed, with an explicit adjustment for every billed month. See ./services.ts.
 */
export {
  type BackDatedAddConnectionCommand,
  BackDatedAddConnectionInput,
  type PreviewAddConnectionCommand,
  PreviewAddConnectionInput,
} from "./inputs";
export { backDatedAddConnection, previewAddConnection } from "./services";
export type { AddConnectionPreview, BackDatedAddConnectionResult } from "./types";
