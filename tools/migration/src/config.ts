/**
 * What we know (and guess) about the legacy MariaDB schema.
 *
 * The docs name the tables (`operator`, `costumer`, `vc`, `invoice`, `ledger`, `lineman`, `plan`,
 * `recharge`) and a few columns (`op_id`, `isReceipt`, `isDeleted`, a nullable invoice customer
 * reference, FLOAT ledger amounts). Every other column name is unknown until a human runs the
 * profiler on the real dump. So the checks below list **candidate** column names: the profiler
 * uses the first candidate a table actually has (case-insensitive) and says in the report which
 * one it used, or that the check was skipped because none matched. After the first real run,
 * replace the guesses with the real names (T-091 mapping).
 *
 * The generic checks (row counts, nulls, zero dates, float anomalies, distinct status values)
 * need no configuration: they run on every column of every copied table.
 */

/** Legacy tables named in BRD §13 / PRD §14 and Appendix A. Others found in the dump are profiled too. */
export const DOCUMENTED_TABLES = [
  "operator",
  "costumer",
  "vc",
  "invoice",
  "ledger",
  "lineman",
  "plan",
  "recharge",
] as const;

/** Baseline counts from PRD Appendix A (for a "documented vs found" column in the report). */
export const BASELINE_COUNTS: Readonly<Record<string, number>> = {
  operator: 8,
  costumer: 7616,
  vc: 7334,
  invoice: 146224,
  ledger: 7334,
  lineman: 134,
};

/** Column that holds the tenant (operator) id. `op_id` is documented (PRD §14). */
export const OPERATOR_COLUMN_CANDIDATES = ["op_id", "operator_id", "opid", "operator"] as const;

/** The operator table and its key. */
export const OPERATOR_TABLE = "operator";
export const OPERATOR_KEY_CANDIDATES = ["op_id", "id", "operator_id"] as const;

/** A reference from a child table to a parent table, checked for nulls, zeros and orphans. */
export interface RelationCheck {
  readonly name: string;
  readonly table: string;
  readonly columnCandidates: readonly string[];
  readonly parent: string;
  readonly parentKeyCandidates: readonly string[];
}

const CUSTOMER_REF = ["customer", "costumer", "customer_id", "costumer_id", "cust_id", "c_id"];
const CUSTOMER_KEY = ["id", "customer_id", "costumer_id", "cust_id", "c_id"];
const OPERATOR_REF = [...OPERATOR_COLUMN_CANDIDATES];
const OPERATOR_KEY = [...OPERATOR_KEY_CANDIDATES];

export const RELATION_CHECKS: readonly RelationCheck[] = [
  ...["costumer", "vc", "invoice", "ledger", "lineman", "plan", "recharge"].map((table) => ({
    name: `${table} → operator`,
    table,
    columnCandidates: OPERATOR_REF,
    parent: "operator",
    parentKeyCandidates: OPERATOR_KEY,
  })),
  {
    name: "vc → costumer",
    table: "vc",
    columnCandidates: CUSTOMER_REF,
    parent: "costumer",
    parentKeyCandidates: CUSTOMER_KEY,
  },
  {
    name: "invoice → costumer",
    table: "invoice",
    columnCandidates: CUSTOMER_REF,
    parent: "costumer",
    parentKeyCandidates: CUSTOMER_KEY,
  },
  {
    name: "invoice → lineman",
    table: "invoice",
    columnCandidates: ["lineman", "lineman_id", "collected_by", "collector"],
    parent: "lineman",
    parentKeyCandidates: ["id", "lineman_id"],
  },
  {
    name: "invoice → recharge",
    table: "invoice",
    columnCandidates: ["recharge", "recharge_id"],
    parent: "recharge",
    parentKeyCandidates: ["id", "recharge_id"],
  },
  {
    name: "ledger → vc",
    table: "ledger",
    columnCandidates: ["vc", "vc_id"],
    parent: "vc",
    parentKeyCandidates: ["id", "vc_id"],
  },
  {
    name: "ledger → costumer",
    table: "ledger",
    columnCandidates: CUSTOMER_REF,
    parent: "costumer",
    parentKeyCandidates: CUSTOMER_KEY,
  },
  {
    name: "vc → plan",
    table: "vc",
    columnCandidates: ["plan", "plan_id"],
    parent: "plan",
    parentKeyCandidates: ["id", "plan_id"],
  },
  {
    name: "recharge → vc",
    table: "recharge",
    columnCandidates: ["vc", "vc_id"],
    parent: "vc",
    parentKeyCandidates: ["id", "vc_id"],
  },
  {
    name: "recharge → plan",
    table: "recharge",
    columnCandidates: ["plan", "plan_id"],
    parent: "plan",
    parentKeyCandidates: ["id", "plan_id"],
  },
];

/** Values that should be unique (within an operator when `perOperator`). Reported as counts only. */
export interface DuplicateCheck {
  readonly name: string;
  readonly table: string;
  readonly columnCandidates: readonly string[];
  readonly perOperator: boolean;
}

export const DUPLICATE_CHECKS: readonly DuplicateCheck[] = [
  {
    name: "customer code per operator",
    table: "costumer",
    columnCandidates: ["code", "customer_code", "cust_code", "c_code", "costumer_code"],
    perOperator: true,
  },
  {
    name: "VC number per operator",
    table: "vc",
    columnCandidates: ["vc_no", "vcno", "vc_number", "vc_num", "vc"],
    perOperator: true,
  },
  {
    name: "invoice number per operator",
    table: "invoice",
    columnCandidates: ["invoice_no", "invoice_number", "inv_no", "bill_no"],
    perOperator: true,
  },
  {
    name: "lineman login (global)",
    table: "lineman",
    columnCandidates: ["login", "username", "user_name", "user_id", "userid"],
    perOperator: false,
  },
  {
    name: "operator display name (global)",
    table: "operator",
    columnCandidates: ["name", "op_name", "operator_name", "company_name"],
    perOperator: false,
  },
];

/**
 * Column-name words (see `columnWords`: `customerName`, `customer_name` and `CUSTOMERNAME` all
 * split into words) that mark a column as **sensitive**: its values are never reported.
 * Matching is by whole word, and also by substring for the roots in `SENSITIVE_ROOTS`, so
 * `cname`/`mobileno`/`passwd2` are caught too. Erring towards "sensitive" only hides values.
 */
export const SENSITIVE_WORDS = new Set([
  "name",
  "names",
  "fname",
  "lname",
  "mname",
  "cname",
  "father",
  "mother",
  "husband",
  "wife",
  "owner",
  "contact",
  "person",
  "mobile",
  "mob",
  "mobno",
  "phone",
  "ph",
  "tel",
  "telephone",
  "whatsapp",
  "cell",
  "address",
  "addr",
  "add1",
  "add2",
  "street",
  "landmark",
  "house",
  "locality",
  "village",
  "pincode",
  "pin",
  "zip",
  "email",
  "mail",
  "password",
  "passwd",
  "pass",
  "pwd",
  "hash",
  "salt",
  "token",
  "secret",
  "otp",
  "login",
  "username",
  "user",
  "uname",
  "aadhaar",
  "aadhar",
  "pan",
  "gstin",
  "gst",
  "kyc",
  "remark",
  "remarks",
  "note",
  "notes",
  "comment",
  "comments",
  "description",
  "desc",
  "dob",
  "birth",
  "ip",
  "imei",
  "device",
  "lat",
  "lng",
  "lon",
  "latitude",
  "longitude",
  "photo",
  "image",
  "sign",
  "signature",
]);
export const SENSITIVE_ROOTS = [
  "name",
  "mobile",
  "phone",
  "addr",
  "email",
  "passw",
  "pwd",
  "token",
  "secret",
  "aadha",
  "remark",
  "contact",
  "father",
  "owner",
  "landmark",
  "street",
  "login",
] as const;

/**
 * Sensitive columns that identify a person or hold a secret. Their values (names, phones,
 * addresses, logins, passwords …) are collected from the copied data and are forbidden in the
 * profile: the PII check fails if any of them shows up. Free-text columns (remarks, notes) are
 * sensitive but not in this list, because single generic words in them ("paid", "cash") would
 * make every report fail; their values are never reported anyway.
 */
export const IDENTIFYING_WORDS = new Set([
  "name",
  "names",
  "fname",
  "lname",
  "mname",
  "cname",
  "uname",
  "father",
  "mother",
  "husband",
  "wife",
  "owner",
  "contact",
  "person",
  "mobile",
  "mob",
  "mobno",
  "phone",
  "ph",
  "tel",
  "telephone",
  "whatsapp",
  "cell",
  "address",
  "addr",
  "add1",
  "add2",
  "street",
  "landmark",
  "house",
  "locality",
  "village",
  "email",
  "mail",
  "password",
  "passwd",
  "pass",
  "pwd",
  "hash",
  "salt",
  "token",
  "secret",
  "otp",
  "login",
  "username",
  "user",
  "aadhaar",
  "aadhar",
  "pan",
  "gstin",
  "kyc",
  "dob",
  "imei",
]);
export const IDENTIFYING_ROOTS = [
  "name",
  "mobile",
  "phone",
  "addr",
  "email",
  "passw",
  "pwd",
  "token",
  "secret",
  "aadha",
  "contact",
  "father",
  "owner",
  "landmark",
  "street",
  "login",
] as const;

/** Name columns: their single words (first names, surnames) are also forbidden as status values. */
export const PERSON_NAME_ROOTS = [
  "name",
  "father",
  "mother",
  "husband",
  "owner",
  "contact",
] as const;

/**
 * Columns whose distinct values are reported (when few and code-like): status codes, flags and
 * types. `isReceipt`/`has_x` style flags, ENUM/SET/BIT/TINYINT(1) columns, and these words.
 */
export const ENUM_WORDS = new Set([
  "status",
  "state",
  "type",
  "mode",
  "flag",
  "kind",
  "active",
  "deleted",
  "enabled",
  "disabled",
  "method",
  "category",
  "stage",
  "paymode",
  "paytype",
]);

/** Columns whose numbers are money (for unit evidence: whole hundreds, negatives, fractions). */
export const MONEY_WORDS = new Set([
  "amount",
  "amt",
  "rent",
  "rental",
  "price",
  "paid",
  "due",
  "dues",
  "balance",
  "bal",
  "total",
  "charge",
  "charges",
  "fee",
  "fees",
  "discount",
  "advance",
  "outstanding",
  "collection",
  "collected",
  "payable",
  "mrp",
  "cost",
]);

/** Distinct status values are listed only when a column has at most this many. */
export const MAX_ENUM_VALUES = 25;
/** A status value is shown only when at least this many rows have it (rarer values are counted, not shown). */
export const MIN_ENUM_VALUE_ROWS = 5;
/** A status value is shown only when it looks like a code: short, no spaces beyond one, no digits run. */
export const ENUM_VALUE_PATTERN = /^[A-Za-z0-9_.-]{1,16}( [A-Za-z0-9_.-]{1,16})?$/;

/** The Postgres schema the raw copy goes into. */
export const LEGACY_SCHEMA = "legacy";
