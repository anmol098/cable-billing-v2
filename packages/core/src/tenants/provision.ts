/**
 * Tenant provisioning (T-027, D-15, D-20, PLAN §12.3): one transaction that creates a working
 * tenant, used by self sign-up (after the email is verified), the platform admin console (T-086)
 * and the legacy migration (T-092). No email step here: callers decide how the owner was checked.
 *
 * In one `withTenant(operatorId)` transaction (T-021 decision 3: the new tenant inserts its own
 * `operators` row; no platform INSERT on tenant tables):
 *
 * 1. `operators` (status active, default settings; the office phone is the owner's mobile),
 * 2. the owner `users` row (+ `accounts` credential row with the argon2id hash, when given),
 * 3. `subscriptions` (`trialing`, `trial_ends_at` per {@link trialEndsAt}: +30 days, D-20),
 * 4. `counters` (invoice, receipt, customer_code at 1),
 * 5. one `tenant.provisioned` audit event in the new tenant's log.
 *
 * **Idempotency:** the caller's `operatorId` is the idempotency key. Generate it once
 * (`uuidv7()`) and keep it with the request (sign-up: in the pending sign-up; admin console: in
 * the form; migration: in the legacy id mapping), then retry with the same id as often as needed.
 * The `operators` insert is `ON CONFLICT (id) DO NOTHING`, so a retry, or a concurrent second
 * call (it waits on the first one's row lock and then sees it), finds the tenant and returns it as
 * `already_provisioned` without writing anything. A natural key (business name, mobile) can't be
 * the key: names are not unique (FR-002) and one person may run two businesses. If the id is
 * already used by a tenant whose owner is someone else, the call fails with CONFLICT
 * (`operator_id_in_use`) and reveals nothing about that tenant.
 */
import {
  accounts,
  COUNTER_NAMES,
  counters,
  DEFAULT_OPERATOR_SETTINGS,
  LANGUAGES,
  type Language,
  type OperatorSettingsInput,
  operators,
  parseOperatorSettings,
  sqlStateOf,
  subscriptions,
  type Tx,
  type UserRole,
  users,
  uuidv7,
} from "@cb/db";
import { err, ok, type Result } from "@cb/domain";
import { and, asc, eq } from "drizzle-orm";
import * as z from "zod";
import { writeAuditEvent } from "../audit/audit";
import type { ServiceRuntime } from "../context/runtime";
import { type ServiceError, serviceError, validationError } from "../errors/errors";
import { normalizeIndianMobile, ownerLoginCandidates, TRIAL_DAYS, trialEndsAt } from "./rules";

/** Who asked for the tenant (recorded in the audit event). */
export type ProvisionActor =
  /** The owner signed up and verified their email: the new owner is the actor. */
  | { readonly kind: "self_signup" }
  /** A platform admin created the tenant (T-086). */
  | { readonly kind: "platform_admin"; readonly userId: string }
  /** A job without a person, e.g. the legacy migration (T-092). No actor in the audit row. */
  | { readonly kind: "system"; readonly job: string };

export interface ProvisionTenantInput {
  /** The new tenant's id **and the idempotency key** (see the module comment). A UUID. */
  readonly operatorId: string;
  readonly business: {
    /** Business name (not unique, FR-002). */
    readonly name: string;
    readonly phone?: string | null;
    readonly address?: string | null;
    /** Overrides on top of the defaults (office_phone defaults to the owner's mobile). */
    readonly settings?: OperatorSettingsInput;
    readonly legacySource?: string | null;
    readonly legacyId?: string | null;
  };
  readonly owner: {
    readonly name: string;
    /** Lower-cased on the way in. Unique across all users. */
    readonly email: string | null;
    /** True when the email was proven (self sign-up). Default false. */
    readonly emailVerified?: boolean;
    /** The owner's mobile number (10 digits, or with +91 / 0 / spaces). */
    readonly phone: string | null;
    /**
     * Sign-in name. Default: the mobile number (or `<mobile>-2`, `-3`… if it is taken). Required
     * when there is no mobile number. A given login that is taken fails with `login_taken`.
     */
    readonly login?: string;
    readonly language: Language;
    /**
     * An argon2id hash from `hashPassword` (never a password), or `null` for no password yet
     * (the owner sets one with the reset link; e.g. migrated owners, FR-028).
     */
    readonly passwordHash: string | null;
    readonly legacySource?: string | null;
    readonly legacyId?: string | null;
  };
  /** Trial length in whole IST days after the sign-up day. Default 30 (D-20). */
  readonly trialDays?: number;
  readonly actor: ProvisionActor;
  /** For the audit row. */
  readonly request?: {
    readonly requestId?: string;
    readonly ip?: string;
    readonly userAgent?: string;
  };
}

export interface ProvisionedTenant {
  /** `created` now, or `already_provisioned` by an earlier (or concurrent) call with this id. */
  readonly status: "created" | "already_provisioned";
  readonly operatorId: string;
  readonly ownerUserId: string;
  /** The owner's sign-in name (they can also use their email). */
  readonly ownerLogin: string;
  /** From the subscription row (null if a later change cleared it). */
  readonly trialEndsAt: Date | null;
}

/** Why provisioning was refused. Nothing was written. */
export type ProvisionFailureReason =
  /** Another user already has this email (they should sign in or reset their password). */
  | "email_taken"
  /** The given login (or every mobile-based candidate) is taken. */
  | "login_taken"
  /** `operatorId` belongs to a different tenant. */
  | "operator_id_in_use";

/** CONFLICT with the reason in `details.reason`. */
export type ProvisionConflict = ServiceError<"CONFLICT"> & {
  readonly details: { readonly reason: ProvisionFailureReason };
};

export type ProvisionError = ServiceError<"VALIDATION"> | ProvisionConflict;

const ARGON2_HASH = /^\$argon2id\$/;

const inputSchema = z.object({
  operatorId: z.uuid(),
  business: z.object({
    name: z.string().trim().min(1).max(120),
    phone: z.string().trim().max(20).nullish(),
    address: z.string().trim().max(500).nullish(),
    settings: z.record(z.string(), z.unknown()).optional(),
    legacySource: z.string().max(100).nullish(),
    legacyId: z.string().max(100).nullish(),
  }),
  owner: z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().max(254).pipe(z.email()).nullable(),
    emailVerified: z.boolean().optional(),
    phone: z.string().trim().max(20).nullable(),
    login: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[^\s@]{3,100}$/)
      .optional(),
    language: z.enum(LANGUAGES),
    passwordHash: z.string().regex(ARGON2_HASH).nullable(),
    legacySource: z.string().max(100).nullish(),
    legacyId: z.string().max(100).nullish(),
  }),
  trialDays: z.number().int().min(0).max(366).optional(),
});

/** Thrown inside the transaction to roll it back with a result for the caller. */
class ProvisionRejected extends Error {
  constructor(readonly failure: ProvisionConflict) {
    super("provisioning rejected");
  }
}

function conflict(reason: ProvisionFailureReason): ProvisionConflict {
  const messages: Record<ProvisionFailureReason, string> = {
    email_taken: "Another account already uses this email",
    login_taken: "The sign-in name is taken",
    operator_id_in_use: "This operator id belongs to another tenant",
  };
  return { code: "CONFLICT", message: messages[reason], details: { reason } };
}

function constraintOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const value = (current as { constraint?: unknown }).constraint;
    if (typeof value === "string") return value;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function actorOf(
  actor: ProvisionActor,
  ownerUserId: string,
): { actorId: string | null; actorRole: UserRole | null; source: string } {
  switch (actor.kind) {
    case "self_signup":
      return { actorId: ownerUserId, actorRole: "owner", source: "self_signup" };
    case "platform_admin":
      return { actorId: actor.userId, actorRole: "platform_admin", source: "platform_admin" };
    case "system":
      return { actorId: null, actorRole: null, source: actor.job };
  }
}

/**
 * Creates a tenant with its owner, trial subscription, counters and default settings, in one
 * transaction; idempotent on `input.operatorId`. See the module comment.
 *
 * Results: `ok({ status: "created" | "already_provisioned", … })`, or `err` with VALIDATION (bad
 * input; `details.fields` lists the paths) or CONFLICT (`details.reason`: `email_taken`,
 * `login_taken`, `operator_id_in_use`). Database outages and bugs throw.
 */
export async function provisionTenant(
  runtime: Pick<ServiceRuntime, "db" | "logger" | "now">,
  input: ProvisionTenantInput,
): Promise<Result<ProvisionedTenant, ProvisionError>> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return err(validationError(parsed.error));
  const data = parsed.data;
  const { actor } = input;
  if (actor.kind === "platform_admin" && !z.uuid().safeParse(actor.userId).success) {
    return err(
      serviceError("VALIDATION", "actor.userId must be a UUID", {
        fields: [{ path: "actor.userId", code: "invalid_format" }],
      }),
    );
  }
  if (actor.kind === "system" && !/^[a-z][a-z0-9_]{0,40}$/.test(actor.job)) {
    return err(
      serviceError("VALIDATION", "actor.job must be snake_case", {
        fields: [{ path: "actor.job", code: "invalid_format" }],
      }),
    );
  }
  const mobile = data.owner.phone ? normalizeIndianMobile(data.owner.phone) : null;
  const logins = data.owner.login
    ? [data.owner.login]
    : mobile
      ? ownerLoginCandidates(mobile)
      : null;
  if (!logins) {
    return err(
      serviceError("VALIDATION", "The owner needs a login or a mobile number", {
        fields: [{ path: "owner.login", code: "required" }],
      }),
    );
  }
  let settings: ReturnType<typeof parseOperatorSettings>;
  try {
    settings = parseOperatorSettings({
      ...DEFAULT_OPERATOR_SETTINGS,
      office_phone: mobile,
      ...data.business.settings,
    });
  } catch (error) {
    if (error instanceof z.ZodError) return err(validationError(error));
    throw error;
  }

  const operatorId = data.operatorId.toLowerCase();
  const now = runtime.now();
  const trialEnd = trialEndsAt(now, data.trialDays ?? TRIAL_DAYS);

  /** The tenant that already has this id, if its owner is the one asked for. */
  async function existing(tx: Tx): Promise<ProvisionedTenant> {
    const [owner] = await tx
      .select({ id: users.id, login: users.login, email: users.email, phone: users.phone })
      .from(users)
      .where(and(eq(users.operatorId, operatorId), eq(users.role, "owner")))
      .orderBy(asc(users.createdAt), asc(users.id))
      .limit(1);
    const sameOwner =
      owner !== undefined &&
      (data.owner.email !== null
        ? owner.email === data.owner.email
        : owner.email === null && owner.phone === (mobile ?? data.owner.phone));
    if (!owner || !sameOwner) throw new ProvisionRejected(conflict("operator_id_in_use"));
    const [subscription] = await tx
      .select({ trialEndsAt: subscriptions.trialEndsAt })
      .from(subscriptions)
      .where(eq(subscriptions.operatorId, operatorId));
    return {
      status: "already_provisioned",
      operatorId,
      ownerUserId: owner.id,
      ownerLogin: owner.login,
      trialEndsAt: subscription?.trialEndsAt ?? null,
    };
  }

  /** Inserts the owner with the first free login (each try in a savepoint). */
  async function insertOwner(tx: Tx, ownerUserId: string, candidates: string[]): Promise<string> {
    for (const login of candidates) {
      try {
        await tx.transaction(async (savepoint) => {
          await savepoint.insert(users).values({
            id: ownerUserId,
            operatorId,
            role: "owner",
            name: data.owner.name,
            login,
            displayLogin: login,
            email: data.owner.email,
            emailVerified: data.owner.emailVerified ?? false,
            phone: mobile ?? data.owner.phone,
            language: data.owner.language,
            legacySource: data.owner.legacySource ?? null,
            legacyId: data.owner.legacyId ?? null,
          });
        });
        return login;
      } catch (error) {
        if (sqlStateOf(error) !== "23505") throw error;
        const constraint = constraintOf(error);
        if (constraint === "users_email_unique")
          throw new ProvisionRejected(conflict("email_taken"));
        if (constraint !== "users_login_unique") throw error;
        // Taken: try the next candidate.
      }
    }
    throw new ProvisionRejected(conflict("login_taken"));
  }

  let outcome: ProvisionedTenant;
  try {
    outcome = await runtime.db.withTenant(operatorId, async (tx) => {
      const inserted = await tx
        .insert(operators)
        .values({
          id: operatorId,
          name: data.business.name,
          phone: data.business.phone ?? mobile,
          address: data.business.address ?? null,
          settings,
          legacySource: data.business.legacySource ?? null,
          legacyId: data.business.legacyId ?? null,
        })
        .onConflictDoNothing({ target: operators.id })
        .returning({ id: operators.id });
      // Someone (an earlier try, or a concurrent call we just waited for) already created it.
      if (inserted.length === 0) return existing(tx);

      const ownerUserId = uuidv7();
      const ownerLogin = await insertOwner(tx, ownerUserId, logins);
      if (data.owner.passwordHash !== null) {
        await tx.insert(accounts).values({
          id: uuidv7(),
          userId: ownerUserId,
          accountId: ownerUserId,
          providerId: "credential",
          password: data.owner.passwordHash,
        });
      }
      await tx.insert(subscriptions).values({
        operatorId,
        status: "trialing",
        trialEndsAt: trialEnd,
      });
      await tx
        .insert(counters)
        .values(COUNTER_NAMES.map((name) => ({ operatorId, name, nextValue: 1 })))
        .onConflictDoNothing();
      const actor = actorOf(input.actor, ownerUserId);
      await writeAuditEvent(tx, {
        operatorId,
        actorId: actor.actorId,
        actorRole: actor.actorRole,
        action: "tenant.provisioned",
        entityType: "operator",
        entityId: operatorId,
        // Codes and ids only (no names, phones or emails in the audit diff).
        after: {
          source: actor.source,
          owner_user_id: ownerUserId,
          subscription_status: "trialing",
          trial_ends_at: trialEnd.toISOString(),
        },
        ip: input.request?.ip ?? null,
        userAgent: input.request?.userAgent ?? null,
        requestId: input.request?.requestId ?? null,
      });
      return {
        status: "created" as const,
        operatorId,
        ownerUserId,
        ownerLogin,
        trialEndsAt: trialEnd,
      };
    });
  } catch (error) {
    if (error instanceof ProvisionRejected) {
      runtime.logger.warn("tenant.provision_refused", {
        operator_id: operatorId,
        reason: error.failure.details.reason,
      });
      return err(error.failure);
    }
    throw error;
  }
  runtime.logger.info("tenant.provisioned", {
    operator_id: outcome.operatorId,
    user_id: outcome.ownerUserId,
    outcome: outcome.status,
    source: actorOf(input.actor, outcome.ownerUserId).source,
  });
  return ok(outcome);
}
