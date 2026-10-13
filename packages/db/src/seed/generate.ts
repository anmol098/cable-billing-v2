/**
 * The seed generator (T-036): one operator's master data and months of billing history, simulated
 * day by day with the real domain rules, so the result looks like the app produced it.
 *
 * Money goes through `@cb/domain` exactly as the services do (PLAN §8):
 * - monthly runs: `buildInvoice` (T-040) per customer on the 1st, with only what was recorded
 *   before the run (assignments, events, pending debit adjustments), then `applyCredit` (T-041);
 * - payments: `allocate` (T-041), oldest invoice first, remainder → credit;
 * - reversals: `reverse` (T-041);
 * - plan changes / new connections / reactivations after the run: `planChangeForPeriod` and
 *   `midMonthStartForPeriod` (T-042) with the operator's D-18 policy.
 * The rows are then written as T-044/T-045/T-046 would write them (ledger.test.ts's reference
 * services and T-046's `postPaymentInTx` are the models). Every customer's account is checked with
 * `checkLedger` before anything is written; a violation is a generator bug and throws.
 *
 * Determinism: every random choice, every id (a seeded UUIDv7 generator on the simulated clock)
 * and every timestamp come from the seed, the operator index and `asOf`. Nothing reads the real
 * clock, so the same inputs always give byte-identical rows (`datasetHash`).
 *
 * Simplifications (documented in the T-036 completion notes):
 * - Assignment events are recorded on their effective date (no back-dating), at office hours.
 * - Debit adjustments reach the ledger through the next invoice's charges (T-041 Q-A default);
 *   credit (payment remainders, credit adjustments) is applied when the next invoice is issued
 *   (Q-B default); "oldest credit" uses `posted_at` (Q-C recommendation).
 * - Customers that existed before the history window have no older invoices; some carry old dues
 *   as an `opening_balance` invoice in the first month (like migrated customers, RULE-21).
 */
import {
  type AllocationRow,
  addDays,
  addPeriods,
  allocate,
  applyCredit,
  type BillingAssignment,
  type BusinessDate,
  buildInvoice,
  businessDateOf,
  type CreditSource,
  checkLedger,
  compareBusinessDates,
  type AssignmentEvent as DomainAssignmentEvent,
  dateParts,
  daysInMonth,
  istStartOfDay,
  type LedgerEntryType,
  type MidMonthStartPolicy,
  midMonthStartForPeriod,
  nextPeriod,
  type OpenInvoice,
  type Paise,
  type PendingAdjustment,
  type Period,
  paise,
  periodOf,
  planChangeForPeriod,
  type RentalChargeRecord,
  reverse,
  yymm,
} from "@cb/domain";
import { createUuidV7Generator } from "../ids";
import type { PaymentMethod, PaymentReviewReason, PaymentSource } from "../schema/payments";
import {
  DEFAULT_OPERATOR_SETTINGS,
  type OperatorSettings,
  parseOperatorSettings,
} from "../schema/tenancy";
import { emptyDataset, type SeedDataset } from "./dataset";
import { Rng } from "./random";
import {
  AREA_NAMES,
  type Bilingual,
  DISCONNECT_REASONS,
  FEMALE_NAMES,
  FREE_PLAN,
  MALE_NAMES,
  MANUAL_CREDIT_REASONS,
  MANUAL_DEBIT_REASONS,
  PHONE_MODELS,
  PLAN_CATALOGUE,
  RETIRED_PLAN,
  REVERSAL_REASONS,
  SURNAMES,
} from "./words";

// ── Public shapes ────────────────────────────────────────────────────────────────────────────────

/** What to generate for one operator. */
export interface OperatorSpec {
  /** 0-based position; with the seed it selects the operator's random stream. */
  readonly index: number;
  readonly name: string;
  readonly customers: number;
  readonly linemen: number;
}

export interface GenerateOptions {
  /** The seed (any string or number); same seed → same data. */
  readonly seed: string;
  /** Months of billing history, ending with the month of `asOf` (≥ 1). */
  readonly months: number;
  /** The simulated "today" (IST business date): nothing happens after it. */
  readonly asOf: BusinessDate;
  /**
   * A password hash (argon2id PHC string, as T-026's `hashPassword` makes) for every seeded user's
   * `credential` account, or null to create users without a password.
   */
  readonly passwordHash: string | null;
}

/** A user the seed created (for the dev login list). */
export interface SeedLogin {
  readonly operatorName: string;
  readonly role: "owner" | "staff" | "lineman";
  readonly login: string;
}

export interface GeneratedOperator {
  readonly operatorId: string;
  readonly name: string;
  readonly data: SeedDataset;
  readonly logins: readonly SeedLogin[];
}

// ── Tunables (per customer / per month probabilities) ────────────────────────────────────────────

const P = {
  initialShare: 0.82,
  secondVc: 0.06,
  churnInitial: 0.13,
  churnJoiner: 0.06,
  partialChurn: 0.3,
  suspend: 0.07,
  reactivate: 0.65,
  planChange: 0.08,
  planChangeFromRetired: 0.5,
  retiredPlan: 0.1,
  customAmount: 0.03,
  freePlan: 0.01,
  openingBalance: 0.12,
  reuseVc: 0.6,
  retireFreedVc: 0.25,
  manualAdjustment: 0.012,
  manualDebitShare: 0.6,
  inactivePays: 0.35,
  reversal: 0.004,
  collectorMismatch: 0.003,
  reviewResolved: 0.7,
  android: 0.75,
  upiAndroid: 0.25,
  upiWeb: 0.4,
  altPhone: 0.15,
  noPhone: 0.08,
  devanagariName: 0.3,
} as const;

type Profile = "regular" | "late" | "partial" | "advance" | "defaulter";
const PROFILES: readonly (readonly [Profile, number])[] = [
  ["regular", 0.6],
  ["late", 0.14],
  ["partial", 0.12],
  ["advance", 0.05],
  ["defaulter", 0.09],
];

// ── Internal model ───────────────────────────────────────────────────────────────────────────────

interface PlanModel {
  readonly id: string;
  readonly name: string;
  readonly rentalPaise: Paise;
  readonly active: boolean;
}

interface Collector {
  readonly userId: string;
  readonly deviceId: string;
  readonly deviceCode: string;
  provisionalSeq: number;
}

type PlannedEvent =
  | { readonly type: "suspended" | "reactivated" | "disconnected"; readonly date: BusinessDate }
  | { readonly type: "plan_changed"; readonly date: BusinessDate; readonly plan: PlanModel };

interface AssignmentModel {
  id: string;
  readonly customer: CustomerModel;
  vcAssetId: string;
  readonly startDate: BusinessDate;
  /** Planned disconnection (effective) date, if any. */
  readonly plannedEnd: BusinessDate | null;
  readonly planned: PlannedEvent[];
  planId: string | null;
  rentalPaise: Paise;
  readonly initialRentalPaise: Paise;
  status: "active" | "suspended" | "disconnected";
  endDate: BusinessDate | null;
  /** Recorded so far (domain shape, recorded order). */
  readonly events: DomainAssignmentEvent[];
  recorded: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface InvoiceModel {
  readonly id: string;
  readonly period: Period;
  readonly chargesPaise: Paise;
  outstandingPaise: number;
}

interface PaymentModel {
  readonly id: string;
  readonly amountPaise: Paise;
  readonly postedAt: Date;
  readonly method: PaymentMethod;
  readonly source: PaymentSource;
  readonly collectorId: string;
  readonly businessDate: BusinessDate;
  unallocatedPaise: number;
  reversed: boolean;
  /** Every allocation row whose source is this payment (posting + credit application). */
  readonly rows: AllocationRow[];
}

interface CreditAdjustmentModel {
  readonly id: string;
  readonly amountPaise: Paise;
  readonly createdAt: Date;
  unallocatedPaise: number;
}

interface PendingDebit {
  readonly row: SeedDataset["adjustments"][number];
  readonly pending: PendingAdjustment;
}

interface CustomerModel {
  id: string;
  readonly code: string;
  readonly name: string;
  readonly phone: string | null;
  readonly altPhone: string | null;
  readonly address: string;
  readonly areaId: string;
  readonly collector: Collector;
  readonly profile: Profile;
  readonly initial: boolean;
  /** When the customer row is recorded (onboarding for initial customers). */
  readonly joinDate: BusinessDate;
  status: "active" | "inactive";
  createdAt: Date;
  updatedAt: Date;
  readonly assignments: AssignmentModel[];
  // Money state (paise, signed numbers).
  balancePaise: number;
  creditPaise: number;
  balanceUpdatedAt: Date;
  readonly invoices: InvoiceModel[];
  readonly payments: PaymentModel[];
  readonly creditAdjustments: CreditAdjustmentModel[];
  readonly pendingDebits: PendingDebit[];
  /** Rent lines and adjustments per `${assignmentId}|${period}` (T-042 "charged so far"). */
  readonly rentRecords: Map<string, RentalChargeRecord[]>;
  readonly allocationRows: AllocationRow[];
  readonly ledger: { type: LedgerEntryType; amountPaise: Paise }[];
}

interface SessionTotals {
  readonly collectorId: string;
  readonly businessDate: BusinessDate;
  cashAll: number;
  cashLive: number;
  upiLive: number;
  countLive: number;
  firstAt: Date;
  lastAt: Date;
}

interface Action {
  readonly minute: number;
  readonly order: number;
  readonly run: (at: Date) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

const MINUTE = 60_000;
const DAY = 86_400_000;

/** The instant `minuteOfDay` minutes after IST midnight of `date`. */
export function istInstant(date: BusinessDate, minuteOfDay: number): Date {
  return new Date(istStartOfDay(date).getTime() + minuteOfDay * MINUTE);
}

function daysBetween(from: BusinessDate, to: BusinessDate): number {
  return Math.round((istStartOfDay(to).getTime() - istStartOfDay(from).getTime()) / DAY);
}

function maxDate(a: BusinessDate, b: BusinessDate): BusinessDate {
  return compareBusinessDates(a, b) >= 0 ? a : b;
}

const before = (a: BusinessDate, b: BusinessDate) => compareBusinessDates(a, b) < 0;

/** A 10-digit number in the fictional `555` range (no Indian mobile number starts with 5). */
export function fakePhone(rng: Rng): string {
  return `555${rng.digits(7)}`;
}

/** Initials of a business name, for the invoice prefix (`Shiv Cable Network` → `SCN`). */
function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .map((word) =>
      word
        .replace(/[^A-Za-z]/g, "")
        .charAt(0)
        .toUpperCase(),
    )
    .join("");
  return letters.slice(0, 8) || "INV";
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function personName(rng: Rng, devanagari: boolean): string {
  const first: Bilingual = rng.chance(0.62) ? rng.pick(MALE_NAMES) : rng.pick(FEMALE_NAMES);
  const last = rng.pick(SURNAMES);
  return devanagari ? `${first[1]} ${last[1]}` : `${first[0]} ${last[0]}`;
}

const recordKey = (assignmentId: string, period: Period) => `${assignmentId}|${period}`;

// ── Generator ────────────────────────────────────────────────────────────────────────────────────

/** Generates one operator's rows. Pure apart from CPU time: same inputs → same output. */
export function generateOperator(spec: OperatorSpec, options: GenerateOptions): GeneratedOperator {
  if (!Number.isInteger(options.months) || options.months < 1) {
    throw new RangeError("months must be a whole number ≥ 1");
  }
  const rng = new Rng(`cable-billing-seed:${options.seed}`).fork(`operator-${spec.index}`);
  const clock = { ms: 0 };
  const idRng = rng.fork("ids");
  const newId = createUuidV7Generator({ now: () => clock.ms, random: (b) => idRng.fill(b) });
  const data = emptyDataset();
  const logins: SeedLogin[] = [];
  const { asOf } = options;
  const firstPeriod = addPeriods(periodOf(asOf), -(options.months - 1));
  const historyDays: BusinessDate[] = [];
  for (let d: BusinessDate = firstPeriod; !before(asOf, d); d = addDays(d, 1)) historyDays.push(d);
  const onboarding = addDays(firstPeriod, -30);
  const onboardingAt = istInstant(onboarding, 11 * 60);
  const asOfEnd = istInstant(asOf, 23 * 60);
  const tag = pad(spec.index + 1, 2);
  clock.ms = onboardingAt.getTime();

  // ── Operator, subscription ────────────────────────────────────────────────────────────────────
  const operatorId = newId();
  const settings: OperatorSettings = parseOperatorSettings({
    ...DEFAULT_OPERATOR_SETTINGS,
    mid_month_start_policy: spec.index % 2 === 0 ? "charge_full_month" : "start_next_month",
    invoice_prefix: initials(spec.name),
    receipt_footer: spec.index % 2 === 0 ? "धन्यवाद! हर महीने 10 तारीख तक भुगतान करें।" : null,
    office_phone: fakePhone(rng),
    default_language: spec.index % 4 === 3 ? "en" : "hi",
  });
  const policy: MidMonthStartPolicy = settings.mid_month_start_policy;
  data.operators.push({
    id: operatorId,
    name: spec.name,
    phone: settings.office_phone,
    address: `${rng.int(1, 200)}, ${rng.pick(AREA_NAMES)}`,
    settings,
    status: "active",
    createdAt: onboardingAt,
    updatedAt: onboardingAt,
  });
  data.subscriptions.push({
    operatorId,
    status: "active",
    currentPeriodEnd: istInstant(addDays(asOf, rng.int(5, 25)), 0),
    createdAt: onboardingAt,
    updatedAt: onboardingAt,
  });

  // ── Users and devices ─────────────────────────────────────────────────────────────────────────
  const addUser = (role: "owner" | "staff" | "lineman", login: string, withEmail: boolean) => {
    const id = newId();
    data.users.push({
      id,
      operatorId,
      role,
      name: personName(rng, role === "lineman" && rng.chance(0.5)),
      login,
      displayLogin: login,
      email: withEmail ? `${login}@seed.cable.test` : null,
      phone: fakePhone(rng),
      language: role === "lineman" ? "hi" : settings.default_language,
      status: "active",
      createdAt: onboardingAt,
      updatedAt: onboardingAt,
    });
    if (options.passwordHash !== null) {
      data.accounts.push({
        id: newId(),
        userId: id,
        accountId: id,
        providerId: "credential",
        password: options.passwordHash,
        createdAt: onboardingAt,
        updatedAt: onboardingAt,
      });
    }
    if (role !== "lineman" || login.endsWith("01")) {
      logins.push({ operatorName: spec.name, role, login });
    }
    return id;
  };
  const ownerId = addUser("owner", `seed-op${tag}-owner`, true);
  const staffIds = [addUser("staff", `seed-op${tag}-staff1`, true)];
  if (spec.customers >= 500) staffIds.push(addUser("staff", `seed-op${tag}-staff2`, true));
  const officeUsers = [ownerId, ...staffIds];

  const lineCount = Math.max(1, spec.linemen);
  const collectors: Collector[] = [];
  for (let i = 0; i < lineCount; i += 1) {
    const userId = addUser("lineman", `seed-op${tag}-lineman${pad(i + 1, 2)}`, false);
    const deviceId = newId();
    const deviceCode = pad(i, 3).replace(/^0/, "K").slice(0, 3).toUpperCase();
    const disabled = lineCount >= 4 && i === lineCount - 1;
    data.devices.push({
      id: deviceId,
      operatorId,
      userId,
      installId: newId(),
      deviceCode,
      model: rng.pick(PHONE_MODELS),
      osVersion: String(rng.int(8, 15)),
      appVersion: "1.0.0",
      appVersionCode: 1,
      createdAt: onboardingAt,
      lastSeenAt: disabled ? onboardingAt : istInstant(asOf, rng.int(8 * 60, 12 * 60)),
      revokedAt: disabled ? istInstant(addDays(asOf, -rng.int(10, 60)), 12 * 60) : null,
      revokedBy: disabled ? ownerId : null,
    });
    if (disabled) {
      const user = data.users.find((u) => u.id === userId);
      if (user) user.status = "disabled";
    } else {
      collectors.push({ userId, deviceId, deviceCode, provisionalSeq: 0 });
    }
  }

  // ── Areas, plans ──────────────────────────────────────────────────────────────────────────────
  const areaCount = Math.min(AREA_NAMES.length, Math.max(3, Math.round(spec.customers / 120)));
  const areaRows = rng
    .shuffle(AREA_NAMES)
    .slice(0, areaCount)
    .map((name) => ({ id: newId(), name }));
  for (const area of areaRows) {
    data.areas.push({
      id: area.id,
      operatorId,
      name: area.name,
      createdAt: onboardingAt,
      updatedAt: onboardingAt,
    });
  }
  const areaCollectors = areaRows.map((_, i) => {
    const own = collectors.filter((_, j) => j % areaRows.length === i);
    return own.length > 0 ? own : [collectors[i % collectors.length] as Collector];
  });
  const areaWeights = areaRows.map((_, i) => [i, 0.5 + rng.next()] as const);

  const planModels: PlanModel[] = rng
    .shuffle(PLAN_CATALOGUE)
    .slice(0, rng.int(4, 6))
    .sort((a, b) => a[1] - b[1])
    .map(([name, rupees]) => ({
      id: newId(),
      name,
      rentalPaise: paise(rupees * 100),
      active: true,
    }));
  const activePlans = [...planModels];
  const freePlan: PlanModel | null =
    spec.index % 3 === 0
      ? { id: newId(), name: FREE_PLAN[0], rentalPaise: paise(FREE_PLAN[1] * 100), active: true }
      : null;
  const retiredPlan: PlanModel = {
    id: newId(),
    name: RETIRED_PLAN[0],
    rentalPaise: paise(RETIRED_PLAN[1] * 100),
    active: false,
  };
  for (const plan of [...planModels, ...(freePlan ? [freePlan] : []), retiredPlan]) {
    data.plans.push({
      id: plan.id,
      operatorId,
      name: plan.name,
      monthlyAmountPaise: plan.rentalPaise,
      status: plan.active ? "active" : "retired",
      createdAt: onboardingAt,
      updatedAt: onboardingAt,
    });
  }
  const planWeights = activePlans.map(
    (plan, i) => [plan, i === 0 ? 3 : 1 + rng.next() * 2] as const,
  );
  const pickPlan = (initial: boolean): { plan: PlanModel | null; rental: Paise } => {
    if (initial && rng.chance(P.retiredPlan))
      return { plan: retiredPlan, rental: retiredPlan.rentalPaise };
    if (rng.chance(P.customAmount)) return { plan: null, rental: paise(rng.int(22, 48) * 1000) };
    if (freePlan && rng.chance(P.freePlan)) return { plan: freePlan, rental: freePlan.rentalPaise };
    const plan = rng.weighted(planWeights);
    return { plan, rental: plan.rentalPaise };
  };

  // ── Customers and their planned connection lifecycles ─────────────────────────────────────────
  const autoCodes = spec.index % 2 === 0;
  const areaCodeCounters = new Map<number, number>();
  const usedCodes = new Set<string>();
  const initialCount = Math.round(spec.customers * P.initialShare);
  const joinPool = historyDays.length > 1 ? historyDays.slice(1) : historyDays;
  const joinDates = Array.from({ length: spec.customers - initialCount }, () =>
    rng.pick(joinPool),
  ).sort(compareBusinessDates);
  const customersInOrder: CustomerModel[] = [];
  const allAssignments: AssignmentModel[] = [];

  const pickWindowDate = (from: BusinessDate, toExclusive: BusinessDate): BusinessDate | null => {
    const span = daysBetween(from, toExclusive);
    return span >= 1 ? addDays(from, rng.int(0, span - 1)) : null;
  };

  for (let i = 0; i < spec.customers; i += 1) {
    const initial = i < initialCount;
    const joinDate = initial ? onboarding : (joinDates[i - initialCount] as BusinessDate);
    const areaIndex = rng.weighted(areaWeights);
    const area = areaRows[areaIndex] as { id: string; name: string };
    let code: string;
    if (autoCodes) {
      code = String(i + 1);
    } else {
      const next = (areaCodeCounters.get(areaIndex) ?? 0) + 1;
      areaCodeCounters.set(areaIndex, next);
      code = `${String.fromCharCode(65 + areaIndex)}-${pad(next, 3)}`;
    }
    while (usedCodes.has(code.toUpperCase())) code = `${code}A`;
    usedCodes.add(code.toUpperCase());
    const devanagari = rng.chance(P.devanagariName);
    const customer: CustomerModel = {
      id: "",
      code,
      name: personName(rng, devanagari),
      phone: rng.chance(P.noPhone) ? null : fakePhone(rng),
      altPhone: rng.chance(P.altPhone) ? fakePhone(rng) : null,
      address: devanagari
        ? `मकान ${rng.int(1, 400)}, ${area.name}`
        : `House ${rng.int(1, 400)}, ${area.name}`,
      areaId: area.id,
      collector: rng.pick(areaCollectors[areaIndex] as Collector[]),
      profile: rng.weighted(PROFILES),
      initial,
      joinDate,
      status: "active",
      createdAt: onboardingAt,
      updatedAt: onboardingAt,
      assignments: [],
      balancePaise: 0,
      creditPaise: 0,
      balanceUpdatedAt: onboardingAt,
      invoices: [],
      payments: [],
      creditAdjustments: [],
      pendingDebits: [],
      rentRecords: new Map(),
      allocationRows: [],
      ledger: [],
    };
    customersInOrder.push(customer);

    // Connections: start dates, churn, events.
    const firstStart = initial ? addDays(firstPeriod, -rng.int(30, 6 * 365)) : joinDate;
    const starts = [firstStart];
    if (rng.chance(P.secondVc)) {
      const second = addDays(firstStart, rng.int(0, 400));
      if (!before(asOf, second)) starts.push(second);
    }
    let churn: BusinessDate | null = null;
    if (rng.chance(initial ? P.churnInitial : P.churnJoiner)) {
      const from = maxDate(addDays(firstStart, 30), addDays(firstPeriod, 3));
      churn = pickWindowDate(from, asOf);
    }
    const partial = churn !== null && starts.length > 1 && rng.chance(P.partialChurn);
    starts.forEach((start, n) => {
      const ends = churn !== null && (!partial || n === 1) ? churn : null;
      if (ends !== null && !before(start, ends)) return; // would end before it starts: drop it
      const { plan, rental } = pickPlan(initial && before(start, firstPeriod));
      const planned: PlannedEvent[] = [];
      const windowFrom = maxDate(addDays(start, 1), firstPeriod);
      const windowTo = ends ?? addDays(asOf, 1);
      const taken = new Set<string>();
      const take = (date: BusinessDate | null) => {
        if (date === null || taken.has(date) || !before(date, windowTo)) return null;
        taken.add(date);
        return date;
      };
      if (rng.chance(P.suspend)) {
        const s = take(pickWindowDate(windowFrom, windowTo));
        if (s !== null) {
          planned.push({ type: "suspended", date: s });
          if (rng.chance(P.reactivate)) {
            const r = take(addDays(s, rng.int(15, 120)));
            if (r !== null) planned.push({ type: "reactivated", date: r });
          }
        }
      }
      const changeChance = plan?.active === false ? P.planChangeFromRetired : P.planChange;
      if (rng.chance(changeChance)) {
        const options = activePlans.filter((p) => p.id !== plan?.id);
        const c = take(pickWindowDate(windowFrom, windowTo));
        if (c !== null && options.length > 0) {
          planned.push({ type: "plan_changed", date: c, plan: rng.pick(options) });
        }
      }
      if (ends !== null) planned.push({ type: "disconnected", date: ends });
      planned.sort((a, b) => compareBusinessDates(a.date, b.date));
      const assignment: AssignmentModel = {
        id: "",
        customer,
        vcAssetId: "",
        startDate: start,
        plannedEnd: ends,
        planned,
        planId: plan?.id ?? null,
        rentalPaise: rental,
        initialRentalPaise: rental,
        status: "active",
        endDate: null,
        events: [],
        recorded: false,
        createdAt: onboardingAt,
        updatedAt: onboardingAt,
      };
      customer.assignments.push(assignment);
      allAssignments.push(assignment);
    });
  }

  // ── VC assets, with sequential reuse (PRD §15 #6, RULE-07) ────────────────────────────────────
  interface VcAsset {
    id: string;
    readonly number: string;
    lastEnd: BusinessDate | null;
    retired: boolean;
    readonly createdAt: Date;
  }
  const vcAssets: VcAsset[] = [];
  const usedVcNumbers = new Set<string>();
  const newVcAsset = (createdAt: Date): VcAsset => {
    let digits = `0${rng.digits(11)}`;
    while (usedVcNumbers.has(digits)) digits = `0${rng.digits(11)}`;
    usedVcNumbers.add(digits);
    // Some cards are typed with the printed grouping; the database normalises them.
    const number = rng.chance(0.2) ? digits.replace(/(\d{4})(?=\d)/g, "$1 ") : digits;
    const asset: VcAsset = { id: "", number, lastEnd: null, retired: false, createdAt };
    vcAssets.push(asset);
    return asset;
  };
  const freed: VcAsset[] = []; // FIFO of VCs whose last assignment has ended
  const vcOf = new Map<AssignmentModel, VcAsset>();
  const endings = allAssignments
    .filter((a) => a.plannedEnd !== null)
    .sort((a, b) =>
      compareBusinessDates(a.plannedEnd as BusinessDate, b.plannedEnd as BusinessDate),
    );
  let nextEnding = 0;
  // Array.prototype.sort is stable: same-day starts keep their (deterministic) creation order.
  const byStart = [...allAssignments].sort((a, b) =>
    compareBusinessDates(a.startDate, b.startDate),
  );
  for (const assignment of byStart) {
    // Free every VC whose assignment ended before this start (both ends inclusive: end < start).
    while (nextEnding < endings.length) {
      const ending = endings[nextEnding] as AssignmentModel;
      if (!before(ending.plannedEnd as BusinessDate, assignment.startDate)) break;
      const asset = vcOf.get(ending);
      if (asset) {
        asset.lastEnd = ending.plannedEnd;
        freed.push(asset);
      }
      nextEnding += 1;
    }
    let asset: VcAsset | undefined;
    if (!before(assignment.startDate, firstPeriod) && freed.length > 0 && rng.chance(P.reuseVc)) {
      asset = freed.shift();
    }
    asset ??= newVcAsset(
      before(assignment.startDate, firstPeriod)
        ? onboardingAt
        : istInstant(assignment.startDate, 10 * 60),
    );
    vcOf.set(assignment, asset);
  }
  for (const asset of freed) {
    if (rng.chance(P.retireFreedVc)) asset.retired = true;
  }

  // ── The simulation ────────────────────────────────────────────────────────────────────────────
  const agenda = new Map<BusinessDate, Action[]>();
  let actionOrder = 0;
  const schedule = (date: BusinessDate, minute: number, run: (at: Date) => void) => {
    if (before(date, firstPeriod) || before(asOf, date)) return;
    const list = agenda.get(date) ?? [];
    list.push({ minute, order: actionOrder++, run });
    agenda.set(date, list);
  };
  const officeMinute = () => rng.int(10 * 60, 18 * 60);
  const officeUser = () => rng.pick(officeUsers);
  const liveCustomers: CustomerModel[] = [];
  const counters = { invoice: 0, receipt: 0 };
  const sessions = new Map<string, SessionTotals>();
  const assetRowIds = new Map<VcAsset, string>();

  const assetIdOf = (asset: VcAsset): string => {
    let id = assetRowIds.get(asset);
    if (id === undefined) {
      id = newId();
      assetRowIds.set(asset, id);
      asset.id = id;
    }
    return id;
  };

  const addLedger = (
    customer: CustomerModel,
    type: LedgerEntryType,
    amountPaise: number,
    ref: {
      invoiceId?: string;
      adjustmentId?: string;
      paymentId?: string;
      paymentReversalId?: string;
    },
    at: Date,
  ) => {
    data.ledgerEntries.push({
      id: newId(),
      operatorId,
      customerId: customer.id,
      type,
      amountPaise,
      invoiceId: ref.invoiceId ?? null,
      adjustmentId: ref.adjustmentId ?? null,
      paymentId: ref.paymentId ?? null,
      paymentReversalId: ref.paymentReversalId ?? null,
      at,
    });
    customer.ledger.push({ type, amountPaise: paise(amountPaise) });
    customer.balancePaise += amountPaise;
    customer.balanceUpdatedAt = at;
  };

  const addRecord = (customer: CustomerModel, record: RentalChargeRecord) => {
    const key = recordKey(record.assignmentId, record.period);
    const list = customer.rentRecords.get(key) ?? [];
    list.push(record);
    customer.rentRecords.set(key, list);
  };

  const openInvoices = (customer: CustomerModel): OpenInvoice[] =>
    customer.invoices
      .filter((inv) => inv.outstandingPaise > 0)
      .map((inv) => ({
        id: inv.id,
        period: inv.period,
        outstandingPaise: paise(inv.outstandingPaise),
      }));

  const invoiceById = (customer: CustomerModel, id: string): InvoiceModel => {
    const invoice = customer.invoices.find((inv) => inv.id === id);
    if (!invoice) throw new Error(`seed: unknown invoice ${id}`);
    return invoice;
  };

  /** Inserts one allocation row (and keeps the in-memory outstanding in step). */
  const addAllocation = (
    customer: CustomerModel,
    row: {
      invoiceId: string;
      sourceType: "payment" | "credit_adjustment";
      sourceId: string;
      amountPaise: number;
      kind: "posting" | "credit_application" | "reversal";
      reversalId?: string;
      reversesAllocationId?: string;
    },
    at: Date,
  ): AllocationRow => {
    const invoice = invoiceById(customer, row.invoiceId);
    invoice.outstandingPaise -= row.amountPaise;
    const id = newId();
    const target = row.kind === "reversal" ? data.reversalAllocations : data.allocations;
    target.push({
      id,
      operatorId,
      customerId: customer.id,
      invoiceId: row.invoiceId,
      sourceType: row.sourceType,
      paymentId: row.sourceType === "payment" ? row.sourceId : null,
      creditAdjustmentId: row.sourceType === "credit_adjustment" ? row.sourceId : null,
      kind: row.kind,
      amountPaise: row.amountPaise,
      outstandingAfterPaise: invoice.outstandingPaise,
      reversalId: row.reversalId ?? null,
      reversesAllocationId: row.reversesAllocationId ?? null,
      createdAt: at,
    });
    const allocation: AllocationRow = {
      id,
      invoiceId: row.invoiceId,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      amountPaise: paise(row.amountPaise),
      reversalId: row.reversalId ?? null,
    };
    customer.allocationRows.push(allocation);
    return allocation;
  };

  /** PLAN §8.5: apply every live credit source to the oldest invoices (balance unchanged). */
  const applyAvailableCredit = (customer: CustomerModel, at: Date) => {
    if (customer.creditPaise <= 0) return;
    const open = openInvoices(customer);
    if (open.length === 0) return;
    const sources: CreditSource[] = [
      ...customer.payments
        .filter((p) => !p.reversed && p.unallocatedPaise > 0)
        .map((p) => ({
          sourceType: "payment" as const,
          sourceId: p.id,
          availablePaise: paise(p.unallocatedPaise),
          at: p.postedAt,
        })),
      ...customer.creditAdjustments
        .filter((c) => c.unallocatedPaise > 0)
        .map((c) => ({
          sourceType: "credit_adjustment" as const,
          sourceId: c.id,
          availablePaise: paise(c.unallocatedPaise),
          at: c.createdAt,
        })),
    ];
    const result = applyCredit(sources, open);
    if (!result.ok) throw new Error(`seed: applyCredit failed: ${result.error.message}`);
    for (const allocation of result.value.allocations) {
      const row = addAllocation(customer, { ...allocation, kind: "credit_application" }, at);
      if (allocation.sourceType === "payment") {
        const payment = customer.payments.find((p) => p.id === allocation.sourceId);
        if (!payment) throw new Error("seed: credit from an unknown payment");
        payment.unallocatedPaise -= allocation.amountPaise;
        payment.rows.push(row);
      } else {
        const credit = customer.creditAdjustments.find((c) => c.id === allocation.sourceId);
        if (!credit) throw new Error("seed: credit from an unknown adjustment");
        credit.unallocatedPaise -= allocation.amountPaise;
      }
    }
    customer.creditPaise -= result.value.appliedPaise;
    customer.balanceUpdatedAt = at;
  };

  const addAdjustment = (
    customer: CustomerModel,
    input: {
      direction: "debit" | "credit";
      amountPaise: Paise;
      source: "plan_change" | "mid_month_start" | "manual";
      assignmentId: string | null;
      period: Period | null;
      reason: string | null;
      createdBy: string;
    },
    at: Date,
  ) => {
    const id = newId();
    const row: SeedDataset["adjustments"][number] = {
      id,
      operatorId,
      customerId: customer.id,
      assignmentId: input.assignmentId,
      period: input.period,
      direction: input.direction,
      amountPaise: input.amountPaise,
      source: input.source,
      reason: input.reason,
      invoiceId: null,
      createdBy: input.createdBy,
      createdAt: at,
    };
    data.adjustments.push(row);
    if (input.assignmentId !== null && input.period !== null) {
      addRecord(customer, {
        kind: "adjustment",
        id,
        assignmentId: input.assignmentId,
        period: input.period,
        direction: input.direction,
        amountPaise: input.amountPaise,
        source: input.source,
      });
    }
    if (input.direction === "debit") {
      customer.pendingDebits.push({
        row,
        pending: {
          id,
          customerId: customer.id,
          assignmentId: input.assignmentId,
          period: input.period,
          direction: "debit",
          amountPaise: input.amountPaise,
          source: input.source,
        },
      });
    } else {
      // A credit adjustment is a credit source with a `credit_adjustment` ledger entry (T-045).
      addLedger(customer, "credit_adjustment", -input.amountPaise, { adjustmentId: id }, at);
      customer.creditPaise += input.amountPaise;
      customer.creditAdjustments.push({
        id,
        amountPaise: input.amountPaise,
        createdAt: at,
        unallocatedPaise: input.amountPaise,
      });
    }
  };

  /** New connection or reactivation after this period's run (D-18, T-042). */
  const midMonthStart = (assignment: AssignmentModel, date: BusinessDate, at: Date) => {
    const customer = assignment.customer;
    const forPeriod = periodOf(date);
    const decision = midMonthStartForPeriod({
      policy,
      rentalPaise: assignment.rentalPaise,
      startedAfterRun: true,
      assignmentId: assignment.id,
      period: forPeriod,
      records: customer.rentRecords.get(recordKey(assignment.id, forPeriod)) ?? [],
    });
    if (!decision.ok)
      throw new Error(`seed: midMonthStartForPeriod failed: ${decision.error.message}`);
    const draft = decision.value.draft;
    if (draft) {
      addAdjustment(
        customer,
        {
          direction: draft.direction,
          amountPaise: draft.amountPaise,
          source: "mid_month_start",
          assignmentId: assignment.id,
          period: draft.period,
          reason: null,
          createdBy: officeUser(),
        },
        at,
      );
    }
  };

  const recordAssignment = (assignment: AssignmentModel, at: Date, imported: boolean) => {
    clock.ms = at.getTime();
    assignment.id = newId();
    const asset = vcOf.get(assignment) as VcAsset;
    assignment.vcAssetId = assetIdOf(asset);
    assignment.recorded = true;
    assignment.createdAt = at;
    assignment.updatedAt = at;
    data.assignmentEvents.push({
      id: newId(),
      operatorId,
      assignmentId: assignment.id,
      type: "activated",
      effectiveDate: assignment.startDate,
      actorId: imported ? null : officeUser(),
      at,
    });
    assignment.events.push({ type: "activated", effectiveDate: assignment.startDate });
    for (const event of assignment.planned) {
      schedule(event.date, officeMinute(), (eventAt) => applyEvent(assignment, event, eventAt));
    }
  };

  const recordCustomer = (customer: CustomerModel, at: Date) => {
    clock.ms = at.getTime();
    customer.id = newId();
    customer.createdAt = at;
    customer.updatedAt = at;
    customer.balanceUpdatedAt = at;
    liveCustomers.push(customer);
  };

  const applyEvent = (assignment: AssignmentModel, event: PlannedEvent, at: Date) => {
    clock.ms = at.getTime();
    const customer = assignment.customer;
    const actorId = officeUser();
    const base = {
      id: newId(),
      operatorId,
      assignmentId: assignment.id,
      effectiveDate: event.date,
      actorId,
      at,
    };
    assignment.updatedAt = at;
    switch (event.type) {
      case "suspended":
        if (assignment.status !== "active") return;
        data.assignmentEvents.push({ ...base, type: "suspended" });
        assignment.events.push({ type: "suspended", effectiveDate: event.date });
        assignment.status = "suspended";
        return;
      case "reactivated":
        if (assignment.status !== "suspended") return;
        data.assignmentEvents.push({ ...base, type: "reactivated" });
        assignment.events.push({ type: "reactivated", effectiveDate: event.date });
        assignment.status = "active";
        midMonthStart(assignment, event.date, at);
        return;
      case "plan_changed": {
        if (assignment.status === "disconnected") return;
        const forPeriod = periodOf(event.date);
        const decision = planChangeForPeriod({
          assignmentId: assignment.id,
          period: forPeriod,
          records: customer.rentRecords.get(recordKey(assignment.id, forPeriod)) ?? [],
          newAmountPaise: event.plan.rentalPaise,
        });
        if (!decision.ok)
          throw new Error(`seed: planChangeForPeriod failed: ${decision.error.message}`);
        data.assignmentEvents.push({
          ...base,
          type: "plan_changed",
          fromPlanId: assignment.planId,
          toPlanId: event.plan.id,
          fromRentalPaise: assignment.rentalPaise,
          toRentalPaise: event.plan.rentalPaise,
        });
        assignment.events.push({
          type: "plan_changed",
          effectiveDate: event.date,
          rentalPaise: event.plan.rentalPaise,
        });
        assignment.planId = event.plan.id;
        assignment.rentalPaise = event.plan.rentalPaise;
        const draft = decision.value.draft;
        if (draft) {
          addAdjustment(
            customer,
            {
              direction: draft.direction,
              amountPaise: draft.amountPaise,
              source: "plan_change",
              assignmentId: assignment.id,
              period: draft.period,
              reason: null,
              createdBy: actorId,
            },
            at,
          );
        }
        return;
      }
      case "disconnected":
        data.assignmentEvents.push({
          ...base,
          type: "disconnected",
          reason: rng.pick(DISCONNECT_REASONS),
        });
        assignment.events.push({ type: "disconnected", effectiveDate: event.date });
        assignment.status = "disconnected";
        assignment.endDate = event.date;
        if (customer.assignments.every((a) => !a.recorded || a.status === "disconnected")) {
          customer.status = "inactive";
          customer.updatedAt = at;
        }
        return;
    }
  };

  // Customers and connections that exist before the history window (imported at onboarding).
  customersInOrder.forEach((customer, i) => {
    if (!customer.initial) return;
    recordCustomer(customer, new Date(onboardingAt.getTime() + i * 1000));
    for (const assignment of customer.assignments) {
      if (before(assignment.startDate, firstPeriod)) {
        recordAssignment(assignment, new Date(onboardingAt.getTime() + i * 1000), true);
      } else {
        schedule(assignment.startDate, officeMinute(), (at) => {
          recordAssignment(assignment, at, false);
          midMonthStart(assignment, assignment.startDate, at);
        });
      }
    }
  });
  // Customers who join during the history window.
  for (const customer of customersInOrder) {
    if (customer.initial) continue;
    schedule(customer.joinDate, officeMinute(), (at) => {
      recordCustomer(customer, at);
      for (const assignment of customer.assignments) {
        if (assignment.startDate === customer.joinDate) {
          recordAssignment(assignment, at, false);
          midMonthStart(assignment, assignment.startDate, at);
        }
      }
    });
    for (const assignment of customer.assignments) {
      if (assignment.startDate !== customer.joinDate) {
        schedule(assignment.startDate, officeMinute(), (at) => {
          recordAssignment(assignment, at, false);
          midMonthStart(assignment, assignment.startDate, at);
        });
      }
    }
  }

  // Old dues of some imported customers: an opening-balance invoice before the first run.
  schedule(firstPeriod, 5 * 60, (at) => {
    for (const customer of liveCustomers) {
      if (!customer.initial || !rng.chance(P.openingBalance)) continue;
      const rental = customer.assignments[0]?.rentalPaise ?? 0;
      if (rental === 0) continue;
      clock.ms = at.getTime();
      const charges = rental * rng.int(1, 3);
      const invoiceId = newId();
      counters.invoice += 1;
      data.invoices.push({
        id: invoiceId,
        operatorId,
        customerId: customer.id,
        period: firstPeriod,
        invoiceNumber: `${settings.invoice_prefix}-${yymm(firstPeriod)}-${pad(counters.invoice, 5)}`,
        kind: "opening_balance",
        openingBalancePaise: 0,
        chargesPaise: charges,
        totalDuePaise: charges,
        issuedAt: at,
        status: "issued",
      });
      customer.invoices.push({
        id: invoiceId,
        period: firstPeriod,
        chargesPaise: paise(charges),
        outstandingPaise: charges,
      });
      addLedger(customer, "opening_balance", charges, { invoiceId }, at);
    }
  });

  // ── Payments ──────────────────────────────────────────────────────────────────────────────────
  type PayKind = "settle" | "partial" | "advance";

  const sessionFor = (collectorId: string, date: BusinessDate, at: Date): SessionTotals => {
    const key = `${collectorId}|${date}`;
    let session = sessions.get(key);
    if (!session) {
      session = {
        collectorId,
        businessDate: date,
        cashAll: 0,
        cashLive: 0,
        upiLive: 0,
        countLive: 0,
        firstAt: at,
        lastAt: at,
      };
      sessions.set(key, session);
    }
    session.lastAt = at;
    return session;
  };

  const monthlyRental = (customer: CustomerModel) =>
    customer.assignments
      .filter((a) => a.recorded && a.status === "active")
      .reduce((sum, a) => sum + a.rentalPaise, 0);

  const amountFor = (customer: CustomerModel, kind: PayKind): number => {
    const balance = customer.balancePaise;
    if (kind === "advance") {
      const rental = monthlyRental(customer);
      if (rental > 0) return Math.max(balance, 0) + rental * rng.int(2, 5);
      return balance;
    }
    if (kind === "partial" && balance > 10_000) {
      const part = Math.floor((balance * (0.4 + rng.next() * 0.4)) / 5_000) * 5_000;
      return Math.max(5_000, part);
    }
    return balance;
  };

  const postPayment = (customer: CustomerModel, kind: PayKind, recordedAt: Date) => {
    const amount = amountFor(customer, kind);
    if (amount <= 0) return;
    const android = rng.chance(P.android);
    const source: PaymentSource = android ? "android" : "web";
    const method: PaymentMethod = rng.chance(android ? P.upiAndroid : P.upiWeb) ? "upi" : "cash";
    const collector = customer.collector;
    const collectorId = android ? collector.userId : officeUser();
    const postedAt = android
      ? new Date(recordedAt.getTime() + rng.int(0, 90) * MINUTE)
      : recordedAt;
    clock.ms = postedAt.getTime();
    const businessDate = businessDateOf(recordedAt);
    const open = openInvoices(customer);
    const result = allocate(paise(amount), open);
    if (!result.ok) throw new Error(`seed: allocate failed: ${result.error.message}`);
    const paymentId = newId();
    const balanceAfter = customer.balancePaise - amount;
    const creditAfter = customer.creditPaise + result.value.creditPaise;
    let reviewReason: PaymentReviewReason | null = null;
    if (customer.status === "inactive") reviewReason = "customer_inactive";
    else if (android && rng.chance(P.collectorMismatch)) reviewReason = "collector_mismatch";
    let resolved: { at: Date; by: string } | null = null;
    if (reviewReason !== null && rng.chance(P.reviewResolved)) {
      const at = new Date(postedAt.getTime() + rng.int(1, 7) * DAY);
      if (at.getTime() <= asOfEnd.getTime()) resolved = { at, by: ownerId };
    }
    data.payments.push({
      id: paymentId,
      operatorId,
      customerId: customer.id,
      amountPaise: amount,
      method,
      upiReference: method === "upi" ? rng.digits(12) : null,
      notes: null,
      collectorId,
      deviceId: android ? collector.deviceId : null,
      source,
      recordedAt,
      postedAt,
      businessDate,
      balanceAfterPaise: balanceAfter,
      creditAfterPaise: creditAfter,
      reviewStatus: reviewReason === null ? "none" : resolved ? "resolved" : "needs_review",
      reviewReason,
      reviewedBy: resolved?.by ?? null,
      reviewedAt: resolved?.at ?? null,
      reviewNote: resolved ? "Checked with the lineman" : null,
    });
    addLedger(customer, "payment", -amount, { paymentId }, postedAt);
    const payment: PaymentModel = {
      id: paymentId,
      amountPaise: paise(amount),
      postedAt,
      method,
      source,
      collectorId,
      businessDate,
      unallocatedPaise: result.value.creditPaise,
      reversed: false,
      rows: [],
    };
    for (const allocation of result.value.allocations) {
      payment.rows.push(
        addAllocation(
          customer,
          {
            invoiceId: allocation.invoiceId,
            sourceType: "payment",
            sourceId: paymentId,
            amountPaise: allocation.amountPaise,
            kind: "posting",
          },
          postedAt,
        ),
      );
    }
    customer.payments.push(payment);
    customer.creditPaise = creditAfter;
    counters.receipt += 1;
    let provisionalRef: string | null = null;
    if (android) {
      collector.provisionalSeq += 1;
      provisionalRef = `P-${collector.deviceCode}-${pad(collector.provisionalSeq, 4)}`;
    }
    data.receipts.push({
      id: newId(),
      operatorId,
      paymentId,
      receiptNumber: `R-${yymm(businessDate)}-${pad(counters.receipt, 5)}`,
      provisionalRef,
      issuedAt: postedAt,
    });
    if (android) {
      const session = sessionFor(collectorId, businessDate, recordedAt);
      if (method === "cash") {
        session.cashAll += amount;
        session.cashLive += amount;
      } else {
        session.upiLive += amount;
      }
      session.countLive += 1;
    }
    if (rng.chance(P.reversal)) {
      schedule(addDays(businessDate, rng.int(1, 5)), officeMinute(), (at) =>
        reversePayment(customer, payment, at),
      );
    }
  };

  const reversePayment = (customer: CustomerModel, payment: PaymentModel, at: Date) => {
    if (payment.reversed) return;
    clock.ms = at.getTime();
    const result = reverse(
      { id: payment.id, amountPaise: payment.amountPaise, reversed: false },
      payment.rows,
    );
    if (!result.ok) throw new Error(`seed: reverse failed: ${result.error.message}`);
    const reversalId = newId();
    data.paymentReversals.push({
      id: reversalId,
      operatorId,
      customerId: customer.id,
      paymentId: payment.id,
      reason: rng.pick(REVERSAL_REASONS),
      actorId: ownerId,
      at,
    });
    addLedger(
      customer,
      "payment_reversal",
      result.value.ledgerDeltaPaise,
      { paymentReversalId: reversalId },
      at,
    );
    for (const row of result.value.allocations) {
      addAllocation(
        customer,
        {
          invoiceId: row.invoiceId,
          sourceType: "payment",
          sourceId: payment.id,
          amountPaise: row.amountPaise,
          kind: "reversal",
          reversalId,
          reversesAllocationId: row.reversesAllocationId,
        },
        at,
      );
    }
    customer.creditPaise += result.value.creditDeltaPaise;
    payment.unallocatedPaise = 0;
    payment.reversed = true;
    if (payment.source === "android") {
      const session = sessions.get(`${payment.collectorId}|${payment.businessDate}`);
      if (!session) throw new Error("seed: reversed Android payment has no collection session");
      if (payment.method === "cash") session.cashLive -= payment.amountPaise;
      else session.upiLive -= payment.amountPaise;
      session.countLive -= 1;
    }
  };

  const manualAdjustment = (customer: CustomerModel, at: Date) => {
    clock.ms = at.getTime();
    const debit = rng.chance(P.manualDebitShare);
    const rupees = debit ? rng.pick([100, 150, 200, 300, 500]) : rng.pick([50, 100, 150, 200]);
    addAdjustment(
      customer,
      {
        direction: debit ? "debit" : "credit",
        amountPaise: paise(rupees * 100),
        source: "manual",
        assignmentId: null,
        period: null,
        reason: rng.pick(debit ? MANUAL_DEBIT_REASONS : MANUAL_CREDIT_REASONS),
        createdBy: officeUser(),
      },
      at,
    );
  };

  /** What each customer does this month (decided right after the run). */
  const planMonth = (forPeriod: Period) => {
    const { year, month } = dateParts(forPeriod);
    const lastDay = daysInMonth(year, month);
    const dayOf = (day: number) => addDays(forPeriod, Math.min(day, lastDay) - 1);
    const payMinute = () => rng.int(8 * 60, 20 * 60);
    for (const customer of liveCustomers) {
      if (customer.status === "inactive") {
        if (customer.balancePaise > 0 && rng.chance(P.inactivePays)) {
          schedule(dayOf(rng.int(3, 25)), payMinute(), (at) => postPayment(customer, "settle", at));
        }
        continue;
      }
      if (rng.chance(P.manualAdjustment)) {
        schedule(dayOf(rng.int(2, 27)), officeMinute(), (at) => manualAdjustment(customer, at));
      }
      const pay = (kind: PayKind, day: number) =>
        schedule(dayOf(day), payMinute(), (at) => postPayment(customer, kind, at));
      switch (customer.profile) {
        case "regular":
          if (rng.chance(0.9)) pay("settle", rng.int(1, 12));
          break;
        case "late":
          if (rng.chance(0.4)) pay("settle", rng.int(5, 28));
          break;
        case "partial":
          if (rng.chance(0.85)) pay("partial", rng.int(3, 20));
          break;
        case "advance":
          if (
            customer.creditPaise === 0 &&
            customer.balancePaise <= monthlyRental(customer) &&
            rng.chance(0.3)
          ) {
            pay("advance", rng.int(1, 10));
          } else if (customer.balancePaise > 0) {
            pay("settle", rng.int(1, 10));
          }
          break;
        case "defaulter":
          if (rng.chance(0.12)) pay("partial", rng.int(5, 28));
          break;
      }
    }
  };

  // ── Monthly billing runs (PLAN §8.2) ──────────────────────────────────────────────────────────
  const runBilling = (forPeriod: Period, runAt: Date) => {
    clock.ms = runAt.getTime();
    const runId = newId();
    const previous = addPeriods(forPeriod, -1);
    let customerCount = 0;
    let createdCount = 0;
    let skippedCount = 0;
    let totalCharges = 0;
    let tick = runAt.getTime();
    for (const customer of liveCustomers) {
      const assignments = customer.assignments.filter(
        (a) => a.recorded && (a.endDate === null || !before(a.endDate, previous)),
      );
      if (assignments.length === 0 && customer.pendingDebits.length === 0) continue;
      tick += 40;
      const at = new Date(tick);
      clock.ms = tick;
      customerCount += 1;
      const input: BillingAssignment[] = assignments.map((a) => ({
        id: a.id,
        customerId: customer.id,
        startDate: a.startDate,
        endDate: a.endDate,
        events: [...a.events],
        initialRentalPaise: a.initialRentalPaise,
      }));
      const outcome = buildInvoice({
        customer: { id: customer.id },
        assignments: input,
        pendingAdjustments: customer.pendingDebits.map((p) => p.pending),
        openingBalancePaise: paise(customer.balancePaise),
        period: forPeriod,
      });
      if (!outcome.ok) throw new Error(`seed: buildInvoice failed: ${outcome.error.message}`);
      if (outcome.value.outcome === "nothing_to_bill") {
        skippedCount += 1;
        data.billingRunItems.push({
          id: newId(),
          operatorId,
          runId,
          customerId: customer.id,
          outcome: "skipped",
          reason: "nothing_to_bill",
          details: {},
          attempts: 1,
          createdAt: at,
          updatedAt: at,
        });
        continue;
      }
      const draft = outcome.value;
      const invoiceId = newId();
      counters.invoice += 1;
      data.invoices.push({
        id: invoiceId,
        operatorId,
        customerId: customer.id,
        period: forPeriod,
        invoiceNumber: `${settings.invoice_prefix}-${yymm(forPeriod)}-${pad(counters.invoice, 5)}`,
        kind: "regular",
        openingBalancePaise: draft.openingBalancePaise,
        chargesPaise: draft.chargesPaise,
        totalDuePaise: draft.totalDuePaise,
        issuedAt: at,
        status: "issued",
      });
      // Mark the carried debit adjustments as billed by this invoice (before the lines).
      const invoiced = new Set(draft.invoicedAdjustmentIds);
      for (let i = customer.pendingDebits.length - 1; i >= 0; i -= 1) {
        const pending = customer.pendingDebits[i] as PendingDebit;
        if (invoiced.has(pending.pending.id)) {
          pending.row.invoiceId = invoiceId;
          customer.pendingDebits.splice(i, 1);
        }
      }
      for (const line of draft.lines) {
        const lineId = newId();
        data.invoiceLines.push({
          id: lineId,
          operatorId,
          invoiceId,
          type: line.type,
          assignmentId: line.assignmentId,
          adjustmentId: line.adjustmentId,
          amountPaise: line.amountPaise,
          createdAt: at,
        });
        if (line.type === "rent") {
          addRecord(customer, {
            kind: "rent",
            id: lineId,
            assignmentId: line.assignmentId,
            period: forPeriod,
            amountPaise: line.amountPaise,
          });
        }
      }
      customer.invoices.push({
        id: invoiceId,
        period: forPeriod,
        chargesPaise: draft.chargesPaise,
        outstandingPaise: draft.chargesPaise,
      });
      addLedger(customer, "invoice", draft.chargesPaise, { invoiceId }, at);
      applyAvailableCredit(customer, at);
      createdCount += 1;
      totalCharges += draft.chargesPaise;
      data.billingRunItems.push({
        id: newId(),
        operatorId,
        runId,
        customerId: customer.id,
        outcome: "created",
        invoiceId,
        details: {},
        attempts: 1,
        createdAt: at,
        updatedAt: at,
      });
    }
    const finishedAt = new Date(tick + 500);
    data.billingRuns.push({
      id: runId,
      operatorId,
      period: forPeriod,
      trigger: "cron",
      status: "completed",
      customerCount,
      createdCount,
      alreadyExistsCount: 0,
      skippedCount,
      failedCount: 0,
      totalChargesPaise: totalCharges,
      startedAt: runAt,
      finishedAt,
      createdAt: runAt,
      updatedAt: finishedAt,
    });
    planMonth(forPeriod);
  };

  for (let p = firstPeriod; !before(asOf, p); p = nextPeriod(p)) {
    const forPeriod = p;
    schedule(forPeriod, 6 * 60, (at) => runBilling(forPeriod, at));
  }

  // Run the days in order; actions scheduled for the current day while it runs are picked up too.
  for (const day of historyDays) {
    const list = agenda.get(day);
    if (!list) continue;
    let done = 0;
    let sortedUpTo = -1;
    while (done < list.length) {
      if (sortedUpTo !== list.length) {
        const rest = list.splice(done).sort((a, b) => a.minute - b.minute || a.order - b.order);
        list.push(...rest);
        sortedUpTo = list.length;
      }
      const action = list[done] as Action;
      done += 1;
      const at = new Date(istInstant(day, action.minute).getTime() + (action.order % 60_000));
      clock.ms = Math.max(clock.ms, at.getTime());
      action.run(at);
    }
    agenda.delete(day);
  }

  // ── Final rows ────────────────────────────────────────────────────────────────────────────────
  for (const customer of liveCustomers) {
    data.customers.push({
      id: customer.id,
      operatorId,
      customerCode: customer.code,
      name: customer.name,
      phone: customer.phone,
      altPhone: customer.altPhone,
      address: customer.address,
      areaId: customer.areaId,
      status: customer.status,
      kyc: {},
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
    });
  }
  for (const asset of vcAssets) {
    const id = assetRowIds.get(asset);
    if (id === undefined) continue; // its only assignment was never recorded (starts after asOf)
    data.vcAssets.push({
      id,
      operatorId,
      vcNumber: asset.number,
      lifecycleStatus: asset.retired ? "retired" : "in_service",
      createdAt: asset.createdAt,
      updatedAt: asset.retired ? asOfEnd : asset.createdAt,
    });
  }
  for (const customer of liveCustomers) {
    for (const assignment of customer.assignments) {
      if (!assignment.recorded) continue;
      data.vcAssignments.push({
        id: assignment.id,
        operatorId,
        vcAssetId: assignment.vcAssetId,
        customerId: customer.id,
        startDate: assignment.startDate,
        endDate: assignment.endDate,
        status: assignment.status,
        planId: assignment.planId,
        rentalAmountPaise: assignment.rentalPaise,
        createdAt: assignment.createdAt,
        updatedAt: assignment.updatedAt,
      });
    }
  }

  for (const customer of liveCustomers) {
    let oldest: Period | null = null;
    for (const invoice of customer.invoices) {
      if (invoice.outstandingPaise > 0 && (oldest === null || before(invoice.period, oldest))) {
        oldest = invoice.period;
      }
    }
    data.customerBalances.push({
      customerId: customer.id,
      operatorId,
      balancePaise: customer.balancePaise,
      creditPaise: customer.creditPaise,
      oldestDuePeriod: oldest,
      updatedAt: customer.balanceUpdatedAt,
    });
    // Every account must satisfy T-041's invariants before anything is written.
    const violations = checkLedger({
      invoices: customer.invoices.map((i) => ({ id: i.id, chargesPaise: i.chargesPaise })),
      payments: customer.payments.map((p) => ({
        id: p.id,
        amountPaise: p.amountPaise,
        reversed: p.reversed,
      })),
      creditAdjustments: customer.creditAdjustments.map((c) => ({
        id: c.id,
        amountPaise: c.amountPaise,
      })),
      allocations: customer.allocationRows,
      ledgerEntries: customer.ledger,
      balancePaise: paise(customer.balancePaise),
      creditPaise: paise(customer.creditPaise),
    });
    if (violations.length > 0) {
      throw new Error(
        `seed: generated ledger breaks T-041 invariants for customer ${customer.id}: ${violations
          .map((v) => v.code)
          .join(", ")}`,
      );
    }
  }

  if (counters.invoice > 0)
    data.counters.push({ operatorId, name: "invoice", nextValue: counters.invoice + 1 });
  if (counters.receipt > 0)
    data.counters.push({ operatorId, name: "receipt", nextValue: counters.receipt + 1 });
  if (autoCodes && liveCustomers.length > 0) {
    data.counters.push({ operatorId, name: "customer_code", nextValue: spec.customers + 1 });
  }

  for (const session of sessions.values()) {
    const today = session.businessDate === asOf;
    const submittedAt = istInstant(session.businessDate, 20 * 60 + 30);
    data.collectionSessions.push({
      id: newId(),
      operatorId,
      collectorId: session.collectorId,
      businessDate: session.businessDate,
      cashExpectedPaise: session.cashLive,
      upiTotalPaise: session.upiLive,
      paymentCount: session.countLive,
      ...(today
        ? { status: "open" as const }
        : {
            // Past days were handed over in full and accepted (reversals came later).
            status: "accepted" as const,
            handoverSubmissionId: newId(),
            handoverCashExpectedPaise: session.cashAll,
            cashHandedOverPaise: session.cashAll,
            discrepancyPaise: 0,
            unsyncedPaymentCount: 0,
            unsyncedCashPaise: 0,
            submittedAt,
            reviewedBy: ownerId,
            reviewedAt: new Date(submittedAt.getTime() + 30 * MINUTE),
          }),
      createdAt: session.firstAt,
      updatedAt: today ? session.lastAt : new Date(submittedAt.getTime() + 30 * MINUTE),
    });
  }

  return { operatorId, name: spec.name, data, logins };
}
