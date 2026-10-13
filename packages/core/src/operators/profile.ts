/**
 * Business profile (T-030, PLAN §12.1 Settings, D-18): the operator's name, office phone,
 * address and the settings in `operators.settings` that change receipts and bills.
 *
 * - `operators.get_profile` (`dashboard.view`: Owner and Staff) reads it, with whether this user
 *   may change it (`editable`: Owner only, not while the tenant is read-only).
 * - `operators.update_profile` (`business_profile.manage`: Owner only, audited, refused with
 *   TENANT_READ_ONLY in read-only mode) saves the whole form in one transaction and writes one
 *   audit event with the changed fields' old and new values.
 *
 * Where the values go (so a change shows up everywhere at once):
 * - **name** → `operators.name`: the web header, receipts (T-050), the lineman app (`/app/config`).
 * - **phone** → `settings.office_phone` **and** `operators.phone` (kept equal): the phone on
 *   receipts (T-050) and the lineman app's "Call office" button (T-028 `/app/config`). Both
 *   readers fall back from `office_phone` to `operators.phone`, so writing both keeps them from
 *   ever showing two different numbers; clearing the phone clears both.
 * - **address** → `operators.address`.
 * - **receipt footer** → `settings.receipt_footer`: receipts and the app config.
 * - **invoice prefix** → `settings.invoice_prefix`: the start of **new** bill numbers
 *   (`{prefix}-{YYMM}-{seq:05}`, PLAN §7.3), read by the billing run (T-044) when it makes bills.
 *   Bills already made keep their numbers; the sequence continues, so numbers stay unique.
 * - **default language** → `settings.default_language`: the receipt page's language (T-050).
 * - **mid-month start policy** → `settings.mid_month_start_policy` (D-18, PLAN §8.3): read when a
 *   connection starts or restarts after the month's bills are made (T-045); a change applies to
 *   starts after it is saved, never to adjustments already made.
 *
 * Unknown keys already in `operators.settings` (added by later tasks) are kept as they are.
 */
import { LANGUAGES, type Language, operatorSettingsSchema, operators } from "@cb/db";
import { err, MID_MONTH_START_POLICIES, type MidMonthStartPolicy, ok } from "@cb/domain";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { defineService } from "../context/service";
import { notFound } from "../errors/errors";
import type { Logger } from "../logging/logger";
import { type SettingsAccess, settingsAccess } from "./access";
import { optionalText, requiredLine } from "./text";

/** Longest values the form accepts (the DB/contract limits: name ≤ 200 on receipts, 500 texts). */
export const BUSINESS_PROFILE_LIMITS = {
  name: 120,
  phone: 20,
  address: 500,
  receiptFooter: 500,
  invoicePrefix: 8,
} as const;

/** Office phone as stored: digits with an optional leading `+`, 6–19 digits (T-021, contract). */
export const OFFICE_PHONE_PATTERN = /^\+?[0-9]{6,19}$/;

/** Invoice prefix as stored: 1–8 upper-case letters or digits (T-021). */
export const INVOICE_PREFIX_PATTERN = /^[A-Z0-9]{1,8}$/;

/** A typed phone without the spaces, dashes, dots and brackets people write in it. */
export function normalizeOfficePhone(value: string): string {
  return value.replace(/[\s\-().]/g, "");
}

/** A typed invoice prefix, trimmed and in capitals (`cb` → `CB`; letters a–z only). */
export function normalizeInvoicePrefix(value: string): string {
  return value.trim().replace(/[a-z]/g, (c) => c.toUpperCase());
}

/**
 * The whole profile form. Every field is required in the input (the form always sends them);
 * optional values are sent as `""` and stored as `null`.
 */
export const UpdateBusinessProfileInput = z.object({
  name: requiredLine(BUSINESS_PROFILE_LIMITS.name),
  phone: z
    .string()
    .transform(normalizeOfficePhone)
    .pipe(
      z
        .string()
        .max(BUSINESS_PROFILE_LIMITS.phone)
        .regex(/^(\+?[0-9]{6,19})?$/),
    )
    .transform((value) => (value === "" ? null : value)),
  address: optionalText(BUSINESS_PROFILE_LIMITS.address),
  receiptFooter: optionalText(BUSINESS_PROFILE_LIMITS.receiptFooter),
  invoicePrefix: z
    .string()
    .transform(normalizeInvoicePrefix)
    .pipe(
      z.string().min(1).max(BUSINESS_PROFILE_LIMITS.invoicePrefix).regex(INVOICE_PREFIX_PATTERN),
    ),
  defaultLanguage: z.enum(LANGUAGES),
  midMonthStartPolicy: z.enum(MID_MONTH_START_POLICIES),
});
export type UpdateBusinessProfileCommand = z.input<typeof UpdateBusinessProfileInput>;

/** The fields of the profile form, as the services read and write them. */
export interface BusinessProfile {
  readonly name: string;
  /** The office phone (receipts + "Call office"); null when not set. */
  readonly phone: string | null;
  readonly address: string | null;
  readonly receiptFooter: string | null;
  readonly invoicePrefix: string;
  readonly defaultLanguage: Language;
  readonly midMonthStartPolicy: MidMonthStartPolicy;
}

export type BusinessProfileField = keyof BusinessProfile;

/** What `operators.get_profile` returns. */
export interface BusinessProfileView extends SettingsAccess {
  /** The operator (tenant) id. */
  readonly id: string;
  readonly profile: BusinessProfile;
  readonly updatedAt: Date;
}

/** What `operators.update_profile` returns. */
export interface UpdateBusinessProfileResult {
  readonly id: string;
  readonly profile: BusinessProfile;
  /** The fields that changed (empty: nothing changed, no audit event). */
  readonly changed: readonly BusinessProfileField[];
  readonly updatedAt: Date;
}

/** Field order in audit events and results (the form's order). */
const FIELDS: readonly BusinessProfileField[] = [
  "name",
  "phone",
  "address",
  "receiptFooter",
  "invoicePrefix",
  "defaultLanguage",
  "midMonthStartPolicy",
];

/** Audit keys: the stored names (settings keys are snake_case). */
const AUDIT_KEY: Record<BusinessProfileField, string> = {
  name: "name",
  phone: "office_phone",
  address: "address",
  receiptFooter: "receipt_footer",
  invoicePrefix: "invoice_prefix",
  defaultLanguage: "default_language",
  midMonthStartPolicy: "mid_month_start_policy",
};

interface OperatorRow {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  settings: unknown;
  updatedAt: Date;
}

const operatorColumns = {
  id: operators.id,
  name: operators.name,
  phone: operators.phone,
  address: operators.address,
  settings: operators.settings,
  updatedAt: operators.updatedAt,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The profile as receipts and the app see it today. Settings are parsed with the T-021 schema
 * (defaults for missing keys); a row that somehow fails it falls back to the defaults (logged).
 */
function profileOf(row: OperatorRow, log: Logger): BusinessProfile {
  const parsed = operatorSettingsSchema.safeParse(isRecord(row.settings) ? row.settings : {});
  if (!parsed.success) {
    log.warn("operators.settings_invalid", { operator_id: row.id });
  }
  const settings = parsed.success ? parsed.data : operatorSettingsSchema.parse({});
  return {
    name: row.name,
    // Same fallback as the receipt page (T-050) and /app/config (T-028).
    phone: settings.office_phone ?? row.phone ?? null,
    address: row.address,
    receiptFooter: settings.receipt_footer,
    invoicePrefix: settings.invoice_prefix,
    defaultLanguage: settings.default_language,
    midMonthStartPolicy: settings.mid_month_start_policy,
  };
}

function pick(profile: BusinessProfile, fields: readonly BusinessProfileField[]) {
  return Object.fromEntries(fields.map((field) => [AUDIT_KEY[field], profile[field]]));
}

/** The business profile, and whether this user may change it. Owner and Staff. */
export const getBusinessProfile = defineService({
  name: "operators.get_profile",
  capability: "dashboard.view",
  input: z.object({}),
  async run({ ctx, tx, log }) {
    const [row] = await tx
      .select(operatorColumns)
      .from(operators)
      .where(eq(operators.id, ctx.operatorId))
      .limit(1);
    if (!row) return err(notFound());
    const access = await settingsAccess(tx, ctx);
    const view: BusinessProfileView = {
      id: row.id,
      profile: profileOf(row, log),
      updatedAt: row.updatedAt,
      ...access,
    };
    return ok(view);
  },
});

/** Saves the business profile form. Owner only; audited; refused in read-only mode. */
export const updateBusinessProfile = defineService({
  name: "operators.update_profile",
  capability: "business_profile.manage",
  input: UpdateBusinessProfileInput,
  async run({ ctx, input, tx, audit, log, now }) {
    const [row] = await tx
      .select(operatorColumns)
      .from(operators)
      .where(eq(operators.id, ctx.operatorId))
      .limit(1)
      .for("update");
    if (!row) return err(notFound());

    const before = profileOf(row, log);
    const after: BusinessProfile = { ...input };
    const changed = FIELDS.filter((field) => before[field] !== after[field]);
    if (changed.length === 0) {
      audit.skip("no_change");
      const result: UpdateBusinessProfileResult = {
        id: row.id,
        profile: before,
        changed,
        updatedAt: row.updatedAt,
      };
      return ok(result);
    }

    // Keep keys this form doesn't know about; validate the known ones with the T-021 schema.
    const raw = isRecord(row.settings) ? row.settings : {};
    const known = operatorSettingsSchema.parse({
      ...raw,
      office_phone: after.phone,
      receipt_footer: after.receiptFooter,
      invoice_prefix: after.invoicePrefix,
      default_language: after.defaultLanguage,
      mid_month_start_policy: after.midMonthStartPolicy,
    });
    const [saved] = await tx
      .update(operators)
      .set({
        name: after.name,
        phone: after.phone,
        address: after.address,
        settings: { ...raw, ...known },
        updatedAt: now,
      })
      .where(eq(operators.id, ctx.operatorId))
      .returning({ id: operators.id, updatedAt: operators.updatedAt });
    if (!saved) return err(notFound());

    await audit.record({
      entityType: "operator",
      entityId: saved.id,
      before: pick(before, changed),
      after: pick(after, changed),
    });
    const result: UpdateBusinessProfileResult = {
      id: saved.id,
      profile: after,
      changed,
      updatedAt: saved.updatedAt,
    };
    return ok(result);
  },
});
