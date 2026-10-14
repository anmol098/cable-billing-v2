/**
 * What the import page's routes and action answer (T-084). Types only, so the client page can use
 * them without pulling `@cb/core` into the browser bundle.
 */
import type {
  ImportApplyResult,
  ImportField,
  ImportFileFormat,
  ImportFileProblemCode,
  ImportLine,
  ImportPreview,
} from "@cb/core";

/** Why a file could not be checked: a whole-file problem, or the user/tenant can't import. */
export type CheckErrorCode =
  | ImportFileProblemCode
  | "no_file"
  | "read_only"
  | "not_allowed"
  | "unexpected";

export interface CheckError {
  readonly code: CheckErrorCode;
  /** `missing_columns` / `duplicate_column`. */
  readonly fields?: readonly ImportField[];
}

export interface CheckedFile {
  readonly name: string;
  readonly format: ImportFileFormat;
  readonly warnings: readonly "not_utf8"[];
  readonly unusedColumns: readonly string[];
}

/** `POST /customers/import/check`. */
export type CheckResponse =
  | {
      readonly ok: true;
      readonly file: CheckedFile;
      readonly lines: readonly ImportLine[];
      readonly preview: ImportPreview;
    }
  | { readonly ok: false; readonly error: CheckError };

export type StepErrorCode = "read_only" | "not_allowed" | "unexpected";

/** `importStepAction`. */
export type StepResponse =
  | { readonly ok: true; readonly result: ImportApplyResult }
  | { readonly ok: false; readonly error: StepErrorCode };

export type ImportFileKind = "xlsx" | "csv";
