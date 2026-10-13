/**
 * Synthetic legacy fixture: fake data shaped like the legacy MariaDB database, used to build and
 * test the staging and profiling tools without the real dump (D-09: the dump never leaves the
 * human who holds it).
 *
 * - **Table names are the documented ones** (`operator`, `costumer`, `vc`, `invoice`, `ledger`,
 *   `lineman`, `plan`, `recharge`; BRD §13, PRD §14 and App. A/B). So are `op_id`, `isReceipt`,
 *   `isDeleted`, the nullable invoice customer reference and the FLOAT ledger amounts.
 * - **Every other column is invented** (a plausible guess). The real names come from the first
 *   profile of the real dump; the tools do not depend on these guesses beyond the candidate lists
 *   in `config.ts`.
 * - **All data is fake**, generated from a seed. It deliberately contains personal-looking data
 *   (names, phone numbers, addresses, passwords, tokens) and plants some of it where a careless
 *   profiler would print it (inside status columns), so the tests can prove none of it leaks.
 * - It also plants the anomalies the profiler must count: zero and invalid dates, null/zero/orphan
 *   references, duplicate customer codes and VC numbers, a duplicated operator name, float amounts
 *   finer than a paisa, negative balances and rare status values.
 */
import type { MemoryTable } from "../source/memory";
import type { LegacyColumn, LegacyValue } from "../source/types";

export type FixtureScale = "small" | "legacy";

interface ScaleSpec {
  readonly operators: number;
  readonly linemen: number;
  readonly customers: number;
  readonly vcs: number;
  readonly invoices: number;
  readonly plansPerOperator: number;
}

/** `legacy` matches the PRD Appendix A baseline counts exactly. */
export const FIXTURE_SCALES: Readonly<Record<FixtureScale, ScaleSpec>> = {
  small: {
    operators: 3,
    linemen: 9,
    customers: 150,
    vcs: 144,
    invoices: 1800,
    plansPerOperator: 3,
  },
  legacy: {
    operators: 8,
    linemen: 134,
    customers: 7616,
    vcs: 7334,
    invoices: 146224,
    plansPerOperator: 6,
  },
};

export interface Fixture {
  readonly tables: readonly MemoryTable[];
  /**
   * Every personal or secret value the fixture holds (names, phones, addresses, logins, passwords,
   * tokens, remarks, and the values planted in status columns). Tests assert none reach a profile.
   */
  readonly personalValues: readonly string[];
  /** Single words planted in status columns (a lineman's first name): must not be shown either. */
  readonly plantedWords: readonly string[];
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_NAMES = [
  "Aarav",
  "Abhishek",
  "Aditi",
  "Ajay",
  "Akash",
  "Amit",
  "Anil",
  "Anita",
  "Anjali",
  "Arjun",
  "Ashok",
  "Bharat",
  "Chandan",
  "Deepak",
  "Dinesh",
  "Divya",
  "Ganesh",
  "Geeta",
  "Gopal",
  "Harish",
  "Indu",
  "Jagdish",
  "Kamla",
  "Kavita",
  "Kiran",
  "Lalit",
  "Mahesh",
  "Manoj",
  "Meena",
  "Mukesh",
  "Naresh",
  "Neha",
  "Nitin",
  "Pankaj",
  "Pooja",
  "Pradeep",
  "Priya",
  "Rajesh",
  "Rakesh",
  "Ramesh",
  "Ravi",
  "Rekha",
  "Sanjay",
  "Santosh",
  "Seema",
  "Shankar",
  "Sunil",
  "Sunita",
  "Suresh",
  "Usha",
  "Vijay",
  "Vinod",
  "Yogesh",
];
const SURNAMES = [
  "Agarwal",
  "Bansal",
  "Chauhan",
  "Devi",
  "Dubey",
  "Gupta",
  "Jain",
  "Kumar",
  "Mishra",
  "Pandey",
  "Patel",
  "Rathore",
  "Saini",
  "Sharma",
  "Singh",
  "Srivastava",
  "Tiwari",
  "Verma",
  "Yadav",
];
const LOCALITIES = [
  "Shastri Nagar",
  "Gandhi Colony",
  "Station Road",
  "Purani Basti",
  "Nehru Vihar",
  "Ram Nagar",
  "Subhash Chowk",
  "Krishna Puri",
  "Azad Mohalla",
  "Shiv Colony",
];
const TOWNS = ["Rampur", "Sitapur", "Bilaspur", "Hamirpur", "Fatehpur"];
const OPERATOR_NAMES = [
  "SHREE GANESH DIGITAL",
  "SHREE GANESH DIGITAL", // two operators share a display name (like the real data, PRD §14)
  "MAA DURGA VISION",
  "SAI KRIPA SATELLITE",
  "JAI HIND DIGITAL",
  "OM SAI VISION",
  "NEW STAR SATELLITE",
  "ROYAL DIGITAL VISION",
];

type ColumnSpec = readonly [name: string, columnType: string, nullable?: boolean];

function columns(specs: readonly ColumnSpec[], primaryKey = "id"): LegacyColumn[] {
  return specs.map(([name, columnType, nullable]) => ({
    name,
    columnType,
    dataType: (columnType.match(/^[a-z]+/)?.[0] ?? columnType).toLowerCase(),
    nullable: nullable ?? false,
    primaryKey: name === primaryKey,
  }));
}

export function generateFixture(options: { scale?: FixtureScale; seed?: number } = {}): Fixture {
  const spec = FIXTURE_SCALES[options.scale ?? "small"];
  const random = rng(options.seed ?? 7);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const int = (min: number, max: number): number => min + Math.floor(random() * (max - min + 1));
  const chance = (p: number): boolean => random() < p;
  const personal = new Set<string>();
  const keep = <T extends string | null>(value: T): T => {
    if (value) personal.add(value);
    return value;
  };
  const usedPhones = new Set<string>();
  const phone = (): string => {
    for (;;) {
      const value = `${pick(["6", "7", "8", "9"])}${String(int(0, 999_999_999)).padStart(9, "0")}`;
      if (!usedPhones.has(value)) {
        usedPhones.add(value);
        return value;
      }
    }
  };
  const personName = () => `${pick(FIRST_NAMES)} ${pick(SURNAMES)}`;
  const address = () =>
    `H.No ${int(1, 450)}, ${pick(LOCALITIES)}, Ward ${int(1, 30)}, ${pick(TOWNS)}`;
  const datetime = (year: number, month: number, day: number) =>
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(int(8, 20)).padStart(2, "0")}:${String(int(0, 59)).padStart(2, "0")}:00`;
  const date = (year: number, month: number, day: number) =>
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const hex = (length: number) =>
    Array.from({ length }, () => "0123456789abcdef"[int(0, 15)] ?? "0").join("");

  // ---- operator ----------------------------------------------------------------------------
  const operatorRows: LegacyValue[][] = [];
  const operatorIds: number[] = [];
  for (let i = 0; i < spec.operators; i++) {
    const opId = i + 1;
    operatorIds.push(opId);
    operatorRows.push([
      opId,
      keep(OPERATOR_NAMES[i % OPERATOR_NAMES.length] ?? "DIGITAL VISION"),
      keep(personName()),
      keep(phone()),
      keep(address()),
      i === spec.operators - 1 ? 0 : 1,
      datetime(2015 + (i % 5), int(1, 12), int(1, 28)),
    ]);
  }
  const opFor = (i: number) => operatorIds[i % operatorIds.length] ?? 1;

  // ---- lineman -----------------------------------------------------------------------------
  const linemanRows: LegacyValue[][] = [];
  const linemanFirstNames: string[] = [];
  const logins: string[] = [];
  for (let i = 0; i < spec.linemen; i++) {
    const first = pick(FIRST_NAMES);
    linemanFirstNames.push(first);
    // One duplicated login (the real data needs a login-uniqueness review, BRD §13).
    const login = i === 1 && logins[0] ? logins[0] : `${first.toLowerCase()}${100 + i}`;
    logins.push(login);
    const password = i % 3 === 0 ? hex(32) : `${first.toLowerCase()}@${int(1000, 9999)}`;
    linemanRows.push([
      i + 1,
      opFor(i),
      keep(`${first} ${pick(SURNAMES)}`),
      keep(phone()),
      keep(login),
      keep(password),
      chance(0.5) ? keep(hex(40)) : null,
      i % 7 === 6 ? 1 : 0,
      datetime(2018 + (i % 6), int(1, 12), int(1, 28)),
    ]);
  }

  // ---- plan --------------------------------------------------------------------------------
  const planRows: LegacyValue[][] = [];
  const planAmounts = [200, 250, 300, 350, 400, 500];
  for (const opId of operatorIds) {
    for (let p = 0; p < spec.plansPerOperator; p++) {
      const amount = planAmounts[p % planAmounts.length] ?? 250;
      planRows.push([planRows.length + 1, opId, `Pack ${amount}`, amount, "active"]);
    }
  }
  const plansOf = (opId: number) => planRows.filter((row) => row[1] === opId);

  // ---- costumer ----------------------------------------------------------------------------
  const customerRows: LegacyValue[][] = [];
  const nullOperatorCustomers = Math.max(2, Math.round(spec.customers * 0.0015));
  const duplicateCodes = Math.max(3, Math.round(spec.customers * 0.005));
  const codesByOp = new Map<number, string[]>();
  for (let i = 0; i < spec.customers; i++) {
    const id = i + 1;
    const opId = opFor(i);
    const codes = codesByOp.get(opId) ?? [];
    let code = `C${String(codes.length + 1).padStart(4, "0")}`;
    if (i >= spec.customers - duplicateCodes && codes.length > 0) code = codes[0] ?? code;
    codes.push(code);
    codesByOp.set(opId, codes);
    let status: string = chance(0.85) ? "active" : "inactive";
    if (i % 25 === 3) status = "Active"; // case variants are a mapping question
    if (i === 10) status = "left"; // rare values (fewer than 5 rows) are held back
    if (i === 11) status = "left";
    const name = keep(personName());
    if (i === 20) status = keep(phone()); // planted: a phone number in a status column
    if (i === 21) status = name; // planted: a customer name in a status column
    let createdAt = datetime(2016 + (i % 8), int(1, 12), int(1, 28));
    if (i % 40 === 5) createdAt = "0000-00-00 00:00:00";
    if (i % 75 === 9) createdAt = "2019-00-10 00:00:00";
    customerRows.push([
      id,
      i < nullOperatorCustomers ? null : opId,
      code,
      name,
      keep(phone()),
      chance(0.3) ? keep(phone()) : null,
      keep(address()),
      `Ward ${int(1, 30)}`,
      status,
      createdAt,
    ]);
  }
  const customerCount = customerRows.length;

  // ---- vc ----------------------------------------------------------------------------------
  const vcRows: LegacyValue[][] = [];
  const vcNumbers = new Map<number, string[]>();
  const plantedWord = linemanFirstNames[0] ?? "Suresh";
  for (let i = 0; i < spec.vcs; i++) {
    const id = i + 1;
    let customer: number | null = (i % customerCount) + 1;
    if (i % 50 === 7) customer = null;
    else if (i % 60 === 8) customer = 0;
    else if (i % 45 === 9) customer = customerCount + 1000 + i; // orphan
    const opId = opFor(typeof customer === "number" && customer > 0 ? customer - 1 : i);
    const numbers = vcNumbers.get(opId) ?? [];
    let vcNo = String(int(1_000_000_000, 9_999_999_999)).slice(0, 10);
    vcNo = `VC${vcNo.slice(0, 8)}`;
    if (i % 70 === 11 && numbers.length > 0) vcNo = numbers[numbers.length - 1] ?? vcNo; // reused VC
    numbers.push(vcNo);
    vcNumbers.set(opId, numbers);
    const plans = plansOf(opId);
    const plan = plans.length > 0 ? pick(plans) : undefined;
    const amount = (plan?.[3] as number | undefined) ?? 250;
    let status = pick(["A", "A", "A", "A", "S", "D"]);
    if (i % 30 === 4) status = plantedWord; // planted: a lineman's first name, frequent enough to pass the row threshold
    let start = date(2017 + (i % 7), int(1, 12), int(1, 28));
    if (i % 25 === 6) start = "0000-00-00";
    const balance = floatAmount(i, random);
    vcRows.push([
      id,
      opId,
      customer,
      vcNo,
      (plan?.[0] as number | undefined) ?? null,
      amount,
      status,
      start,
      balance,
      Math.max(0, balance),
    ]);
  }

  // ---- recharge ----------------------------------------------------------------------------
  const rechargeRows: LegacyValue[][] = [];
  for (const vc of vcRows) {
    const count = int(1, 3);
    for (let r = 0; r < count; r++) {
      const year = 2023 + (r % 2);
      const month = int(1, 12);
      rechargeRows.push([
        rechargeRows.length + 1,
        vc[1] as number,
        rechargeRows.length % 97 === 13 ? vcRows.length + 500 : (vc[0] as number),
        (vc[4] as number | null) ?? null,
        vc[5] as number,
        date(year, month, 1),
        rechargeRows.length % 41 === 2 ? "0000-00-00" : date(year, month, 28),
        pick(["done", "done", "done", "pending"]),
      ]);
    }
  }

  // ---- invoice -----------------------------------------------------------------------------
  const invoiceRows: LegacyValue[][] = [];
  const perCustomer = Math.floor(spec.invoices / customerCount);
  const extra = spec.invoices - perCustomer * customerCount;
  const invoiceNumbers = new Map<number, number>();
  for (let c = 0; c < customerCount; c++) {
    const months = perCustomer + (c < extra ? 1 : 0);
    const customerRow = customerRows[c] as LegacyValue[];
    const opId = (customerRow[1] as number | null) ?? opFor(c);
    for (let m = 0; m < months; m++) {
      const k = invoiceRows.length;
      let customer: number | null = c + 1;
      if (k % 400 === 17) customer = null;
      else if (k % 650 === 23) customer = customerCount + 5000 + k; // orphan
      const seq = (invoiceNumbers.get(opId) ?? 0) + 1;
      invoiceNumbers.set(opId, seq);
      const isReceipt = k % 3 === 0 ? 1 : 0;
      const year = 2024 + Math.floor(m / 12);
      const month = (m % 12) + 1;
      const amount = pick([200, 250, 300, 350, 400, 450, 500]);
      let createdAt = datetime(year, month, int(1, 28));
      if (k % 500 === 31) createdAt = "0000-00-00 00:00:00";
      invoiceRows.push([
        k + 1,
        opId,
        customer,
        `INV${opId}-${String(seq).padStart(6, "0")}`,
        `${year}-${String(month).padStart(2, "0")}`,
        amount,
        isReceipt ? amount - (k % 7 === 0 ? 50 : 0) : 0,
        isReceipt,
        isReceipt ? pick(["cash", "cash", "upi", "CASH"]) : null,
        k % 5 === 0 && rechargeRows.length > 0 ? (k % rechargeRows.length) + 1 : null,
        isReceipt ? (k % 211 === 5 ? spec.linemen + 77 : (k % spec.linemen) + 1) : null,
        k % 20 === 0 ? keep(`paid by ${personName()}, call ${phone()}`) : null,
        createdAt,
      ]);
    }
  }

  // ---- ledger ------------------------------------------------------------------------------
  const ledgerRows: LegacyValue[][] = vcRows.map((vc, i) => {
    const balance = vc[8] as number;
    return [
      i + 1,
      vc[1] as number,
      i % 90 === 12 ? vcRows.length + 900 + i : (vc[0] as number),
      vc[2] as number | null,
      balance,
      Math.max(0, balance),
      i % 4 === 0 ? null : floatAmount(i + 3, random),
      i % 33 === 2 ? "0000-00-00 00:00:00" : datetime(2025, int(1, 12), int(1, 28)),
    ];
  });

  const tables: MemoryTable[] = [
    {
      name: "operator",
      columns: columns(
        [
          ["op_id", "int(11)"],
          ["name", "varchar(100)"],
          ["owner_name", "varchar(100)"],
          ["mobile", "varchar(15)"],
          ["address", "varchar(255)"],
          ["status", "tinyint(1)"],
          ["created_at", "datetime"],
        ],
        "op_id",
      ),
      rows: operatorRows,
    },
    {
      name: "lineman",
      columns: columns([
        ["id", "int(11)"],
        ["op_id", "int(11)"],
        ["name", "varchar(100)"],
        ["mobile", "varchar(15)"],
        ["login", "varchar(50)"],
        ["password", "varchar(64)"],
        ["token", "varchar(64)", true],
        ["isDeleted", "tinyint(1)"],
        ["created_at", "datetime"],
      ]),
      rows: linemanRows,
    },
    {
      name: "plan",
      columns: columns([
        ["id", "int(11)"],
        ["op_id", "int(11)"],
        ["name", "varchar(50)"],
        ["amount", "int(11)"],
        ["status", "varchar(10)"],
      ]),
      rows: planRows,
    },
    {
      name: "costumer",
      columns: columns([
        ["id", "int(11)"],
        ["op_id", "int(11)", true],
        ["code", "varchar(20)"],
        ["name", "varchar(100)"],
        ["mobile", "varchar(15)"],
        ["alt_mobile", "varchar(15)", true],
        ["address", "text"],
        ["area", "varchar(50)"],
        ["status", "varchar(20)"],
        ["created_at", "datetime"],
      ]),
      rows: customerRows,
    },
    {
      name: "vc",
      columns: columns([
        ["id", "int(11)"],
        ["op_id", "int(11)"],
        ["customer", "int(11)", true],
        ["vc_no", "varchar(30)"],
        ["plan", "int(11)", true],
        ["amount", "int(11)"],
        ["status", "varchar(10)"],
        ["start_date", "date"],
        ["balance", "float"],
        ["due", "float"],
      ]),
      rows: vcRows,
    },
    {
      name: "recharge",
      columns: columns([
        ["id", "int(11)"],
        ["op_id", "int(11)"],
        ["vc", "int(11)"],
        ["plan", "int(11)", true],
        ["amount", "int(11)"],
        ["from_date", "date"],
        ["to_date", "date"],
        ["status", "varchar(10)"],
      ]),
      rows: rechargeRows,
    },
    {
      name: "invoice",
      columns: columns([
        ["id", "int(11)"],
        ["op_id", "int(11)"],
        ["customer", "int(11)", true],
        ["invoice_no", "varchar(20)"],
        ["bill_month", "varchar(7)"],
        ["amount", "int(11)"],
        ["paid", "int(11)"],
        ["isReceipt", "tinyint(1)"],
        ["pay_mode", "varchar(10)", true],
        ["recharge", "int(11)", true],
        ["lineman", "int(11)", true],
        ["remark", "varchar(255)", true],
        ["created_at", "datetime"],
      ]),
      rows: invoiceRows,
    },
    {
      name: "ledger",
      columns: columns([
        ["id", "int(11)"],
        ["op_id", "int(11)"],
        ["vc", "int(11)"],
        ["customer", "int(11)", true],
        ["balance", "float"],
        ["due", "float"],
        ["last_paid", "float", true],
        ["updated_at", "datetime"],
      ]),
      rows: ledgerRows,
    },
  ];
  return { tables, personalValues: [...personal], plantedWords: [plantedWord] };
}

/**
 * A rupee amount as the legacy FLOAT columns hold it: mostly whole or half rupees, some finer
 * than a paisa, some negative (advance). At most 6 significant digits, so MariaDB's FLOAT prints
 * back exactly this value and the MariaDB and in-memory copies agree.
 */
function floatAmount(i: number, random: () => number): number {
  const rupees = Math.floor(random() * 2000);
  if (i % 37 === 1) return -Math.floor(random() * 500);
  if (i % 23 === 2) return Number(`${Math.floor(random() * 900)}.333`);
  if (i % 9 === 3) return rupees + 0.5;
  if (i % 11 === 4) return rupees + 0.99;
  return rupees;
}
