/**
 * Create a tenant from the admin console (T-086, PRD J-01 "Platform admin creates tenant and
 * initial owner account"): T-027's `provisionTenant` with the admin as actor.
 *
 * - The form makes `operatorId` once (hidden field): it is provisionTenant's idempotency key, so
 *   a double submit or retry creates one tenant (`already_provisioned`).
 * - No password: the owner sets one with the emailed reset link (the web action asks T-026's
 *   `requestPasswordReset` after this succeeds). The trial starts as for self sign-up (D-20).
 * - `tenant.provisioned` goes to the new tenant's log (provisionTenant); `admin.tenant_created`
 *   to the platform log.
 */
import { LANGUAGES } from "@cb/db";
import { err, ok } from "@cb/domain";
import * as z from "zod";
import { provisionTenant } from "../tenants/provision";
import { defineAdminService } from "./service";

export const CreateTenantInput = z.object({
  operatorId: z.uuid(),
  businessName: z.string().trim().min(1).max(120),
  businessPhone: z.string().trim().max(20).optional(),
  ownerName: z.string().trim().min(1).max(120),
  ownerEmail: z.email().max(254),
  ownerMobile: z.string().trim().min(10).max(20),
  language: z.enum(LANGUAGES),
});

export const createTenantByAdmin = defineAdminService({
  name: "admin.tenant_create",
  input: CreateTenantInput,
  async run({ ctx, input, runtime, audit }) {
    const result = await provisionTenant(runtime, {
      operatorId: input.operatorId,
      business: { name: input.businessName, phone: input.businessPhone || null },
      owner: {
        name: input.ownerName,
        email: input.ownerEmail.toLowerCase(),
        emailVerified: false,
        phone: input.ownerMobile,
        language: input.language,
        passwordHash: null,
      },
      actor: { kind: "platform_admin", userId: ctx.userId },
      request: {
        requestId: ctx.requestId,
        ...(ctx.client?.ip ? { ip: ctx.client.ip } : {}),
        ...(ctx.client?.userAgent ? { userAgent: ctx.client.userAgent } : {}),
      },
    });
    if (!result.ok) return err(result.error);
    await runtime.db.withPlatform((tx) =>
      audit.platform(tx, {
        action: "admin.tenant_created",
        entityType: "operator",
        entityId: result.value.operatorId,
        after: {
          status: result.value.status,
          owner_user_id: result.value.ownerUserId,
          trial_ends_at: result.value.trialEndsAt,
        },
      }),
    );
    return ok(result.value);
  },
});
