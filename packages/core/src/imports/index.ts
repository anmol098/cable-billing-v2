/**
 * Customer import (T-084): read an Excel/CSV file, preview it, import valid customers with their
 * connections in steps, and build the template and problem files. See services.ts for the rules.
 */
export {
  fieldForHeader,
  headerKey,
  IMPORT_FIELDS,
  type ImportField,
  REQUIRED_IMPORT_FIELDS,
} from "./columns";
export { escapeCsvCell, unescapeCsvCell } from "./csv";
export {
  type ImportFileFormat,
  type ImportFileProblem,
  type ImportFileProblemCode,
  type ImportLine,
  type ImportTable,
  readImportFile,
} from "./file";
export { IMPORT_LIMITS } from "./limits";
export {
  type LineProblem,
  type LineProblemCode,
  parseImportDate,
  parseImportRent,
} from "./rules";
export { applyCustomerImport, checkCustomerImport, problemFromServiceError } from "./services";
export {
  buildImportTemplate,
  buildProblemFile,
  IMPORT_CONTENT_TYPES,
  type ImportFileKind,
  type ImportTemplateWords,
  type ProblemFileRow,
  type ProblemFileWords,
} from "./template";
export {
  ApplyCustomerImportInput,
  CheckCustomerImportInput,
  type ImportApplyResult,
  type ImportCheckResult,
  type ImportCounts,
  type ImportCustomerRef,
  type ImportLineResult,
  type ImportLineStatus,
} from "./types";
