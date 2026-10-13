import type { ColumnKind } from "../copy/types";
import type { CopyRunInfo } from "./catalog";
import type { ColumnClass } from "./classify";

/**
 * Everything the profile reports. By construction it holds only counts, identifiers (table and
 * column names, legacy operator ids) and filtered status codes: no field can carry a row's text.
 */
export interface Profile {
  /** IST business date the profile was made (file name `profile-<date>.md`). */
  readonly date: string;
  readonly generatedAt: string;
  readonly copyRun: CopyRunInfo | null;
  readonly tables: readonly TableProfile[];
  readonly operators: OperatorBreakdown | null;
  readonly relations: readonly RelationResult[];
  readonly duplicates: readonly DuplicateResult[];
  readonly missingDocumentedTables: readonly string[];
}

export interface TableProfile {
  readonly name: string;
  readonly documented: boolean;
  readonly baseline: number | null;
  readonly rows: number;
  readonly columns: readonly ColumnProfile[];
}

export interface ColumnProfile {
  readonly name: string;
  readonly sourceType: string;
  readonly kind: ColumnKind;
  readonly class: ColumnClass;
  readonly primaryKey: boolean;
  readonly nulls: number;
  /** Empty or whitespace-only text (text columns only). */
  readonly blank: number | null;
  readonly distinct: number;
  readonly nulBytesRemoved: number;
  readonly dates: DateStats | null;
  readonly numbers: NumberStats | null;
  readonly values: EnumValues | null;
}

export interface DateStats {
  /** `0000-00-00…` */
  readonly zero: number;
  /** Not zero, but not a real date either (`2019-00-10`, `2021-02-30`). */
  readonly invalid: number;
  /** Earliest / latest valid value, date part only. Omitted for sensitive columns. */
  readonly min: string | null;
  readonly max: string | null;
}

export interface NumberStats {
  readonly negative: number;
  readonly zero: number;
  /** Has a fractional part. */
  readonly fractional: number;
  /** Has more than 2 decimal places (finer than a paisa if the unit is rupees). */
  readonly subPaisa: number;
  /** Non-zero multiples of 100 (evidence for paise vs rupees). Money columns only. */
  readonly wholeHundreds: number | null;
}

export interface EnumValues {
  /** Values shown, most frequent first. */
  readonly shown: readonly { readonly value: string; readonly rows: number }[];
  /** Values held back (rare, not code-like, or matching personal data): counted, not shown. */
  readonly suppressedValues: number;
  readonly suppressedRows: number;
  /** Set when the column has too many distinct values to be a status column. */
  readonly tooMany: boolean;
}

export interface OperatorBreakdown {
  /** Operator ids found in the operator table. */
  readonly operatorIds: readonly string[];
  readonly tables: readonly OperatorTableCounts[];
}

export interface OperatorTableCounts {
  readonly table: string;
  readonly column: string;
  /** Rows per operator id (as text), including ids that are not in the operator table. */
  readonly byOperator: Readonly<Record<string, number>>;
  readonly nullOperator: number;
  /** Rows whose operator id is not in the operator table (0 counts here too). */
  readonly unknownOperator: number;
  readonly total: number;
  /** Sum of the per-operator groups (incl. null): should equal `total` (PRD App. A off-by-one). */
  readonly groupSum: number;
}

export type CheckStatus =
  | { readonly checked: true; readonly column: string; readonly parentKey?: string }
  | { readonly checked: false; readonly reason: string };

export interface RelationResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly rows: number;
  readonly nulls: number;
  /** References that are 0 / '' (a common "none" in legacy PHP apps). */
  readonly zero: number;
  readonly orphans: number;
}

export interface DuplicateResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly perOperator: boolean;
  /** Distinct values that occur more than once (within an operator when per-operator). */
  readonly groups: number;
  /** Rows that share a value with another row. */
  readonly rows: number;
  readonly byOperator: readonly {
    readonly operator: string;
    readonly groups: number;
    readonly rows: number;
  }[];
}
