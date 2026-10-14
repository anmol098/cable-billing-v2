/**
 * What the register reports return (T-080). Amounts are integer paise, instants UTC `Date`s,
 * periods IST months.
 */
import type { Paise, Period } from "@cb/domain";
import type { BillPayState, BillRow } from "../../billing/view-types";
import type { ReportAsOf } from "../dues/as-of";

/** `reports.bill_register`. Rows are T-047's `BillRow`, so both registers show the same bill. */
export interface BillRegisterReport {
  readonly asOf: ReportAsOf;
  readonly from: Period;
  readonly to: Period;
  /** Every area of the tenant, by name (the filter's options). */
  readonly areas: readonly { readonly id: string; readonly name: string }[];
  /** Totals over every bill matching the filters (not only this page): the totals row. */
  readonly totals: {
    readonly count: number;
    /** Σ charges (what the bills added to the ledger). */
    readonly chargesPaise: Paise;
    /** Σ paid on them (payments and advance, net of undone payments). */
    readonly paidPaise: Paise;
    /** charges − paid. */
    readonly outstandingPaise: Paise;
    /** Bills per pay state. */
    readonly byState: Readonly<Record<BillPayState, number>>;
  };
  readonly rows: readonly BillRow[];
  readonly page: number;
  readonly pageSize: number;
}
