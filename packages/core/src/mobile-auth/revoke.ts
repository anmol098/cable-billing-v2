/**
 * Revoking mobile sign-ins (PLAN §9.2, §11.6): "Sign out this phone" (Owner, T-032) and the
 * low-level helper every other revocation uses (logout, reuse detection, a deactivated user, a
 * password reset).
 *
 * A revoked refresh-token family can never be refreshed again, and `authenticate` refuses access
 * tokens of a revoked family or device on the next request, so revocation is immediate.
 */
import { devices, mobileRefreshTokens, type RefreshTokenRevokeReason, type Tx } from "@cb/db";
import { err, ok } from "@cb/domain";
import { and, eq, isNull, type SQL } from "drizzle-orm";
import * as z from "zod";
import { defineService } from "../context/service";
import { notFound } from "../errors/errors";

/**
 * Revokes every live refresh token matching the filter, in the caller's `withTenant` transaction.
 * Give at least one of `familyId`, `deviceId`, `userId`. Returns how many tokens were revoked.
 *
 * T-032: deactivating a lineman → `{ userId, reason: "user_disabled" }`; resetting a lineman's
 * password → `{ userId, reason: "password_changed" }` (their phones must sign in again).
 */
export async function revokeMobileRefreshTokens(
  tx: Tx,
  filter: {
    readonly familyId?: string;
    readonly deviceId?: string;
    readonly userId?: string;
    readonly reason: RefreshTokenRevokeReason;
    readonly now: Date;
  },
): Promise<number> {
  const conditions: SQL[] = [isNull(mobileRefreshTokens.revokedAt)];
  if (filter.familyId) conditions.push(eq(mobileRefreshTokens.familyId, filter.familyId));
  if (filter.deviceId) conditions.push(eq(mobileRefreshTokens.deviceId, filter.deviceId));
  if (filter.userId) conditions.push(eq(mobileRefreshTokens.userId, filter.userId));
  if (conditions.length === 1) {
    throw new TypeError("revokeMobileRefreshTokens: give familyId, deviceId or userId");
  }
  const revoked = await tx
    .update(mobileRefreshTokens)
    .set({ revokedAt: filter.now, revokedReason: filter.reason })
    .where(and(...conditions))
    .returning({ id: mobileRefreshTokens.id });
  return revoked.length;
}

export const RevokeDeviceInput = z.object({
  deviceId: z.uuid().transform((id) => id.toLowerCase()),
});
export type RevokeDeviceCommand = z.input<typeof RevokeDeviceInput>;

export interface RevokeDeviceResult {
  readonly deviceId: string;
  readonly revokedAt: Date;
  /** True when the phone was already signed out (nothing changed). */
  readonly alreadyRevoked: boolean;
  /** Refresh tokens revoked by this call. */
  readonly revokedTokens: number;
}

/**
 * "Sign out this phone" (Owner only, `team.manage`; T-032's button). Marks the device revoked
 * (`revoked_at`, `revoked_by`) and revokes all its refresh tokens (`device_revoked`): the phone's
 * next request gets DEVICE_REVOKED and the app shows the login screen, keeping queued payments.
 * The device keeps its `device_code` forever. Signing in on the phone again re-registers it.
 *
 * Idempotent: revoking a revoked device changes nothing (`alreadyRevoked: true`).
 * Another tenant's device id → NOT_FOUND.
 */
export const revokeDevice = defineService({
  name: "devices.revoke",
  capability: "team.manage",
  input: RevokeDeviceInput,
  async run({ ctx, input, tx, audit, log, now }) {
    const [device] = await tx
      .select({ id: devices.id, revokedAt: devices.revokedAt, userId: devices.userId })
      .from(devices)
      .where(eq(devices.id, input.deviceId))
      .for("update");
    if (!device) return err(notFound());

    if (device.revokedAt) {
      // Belt and braces: no live token may survive on a revoked device.
      const stray = await revokeMobileRefreshTokens(tx, {
        deviceId: device.id,
        reason: "device_revoked",
        now,
      });
      if (stray === 0) {
        audit.skip("no_change");
        return ok<RevokeDeviceResult>({
          deviceId: device.id,
          revokedAt: device.revokedAt,
          alreadyRevoked: true,
          revokedTokens: 0,
        });
      }
      await audit.record({
        entityType: "device",
        entityId: device.id,
        after: { revoked_count: stray },
      });
      return ok<RevokeDeviceResult>({
        deviceId: device.id,
        revokedAt: device.revokedAt,
        alreadyRevoked: true,
        revokedTokens: stray,
      });
    }

    await tx
      .update(devices)
      .set({ revokedAt: now, revokedBy: ctx.userId })
      .where(eq(devices.id, device.id));
    const revokedTokens = await revokeMobileRefreshTokens(tx, {
      deviceId: device.id,
      reason: "device_revoked",
      now,
    });
    await audit.record({
      entityType: "device",
      entityId: device.id,
      before: { revoked_at: null },
      after: {
        revoked_at: now.toISOString(),
        user_id: device.userId,
        revoked_count: revokedTokens,
      },
    });
    log.info("mobile_auth.device_revoked", {
      device_id: device.id,
      revoked_count: revokedTokens,
    });
    return ok<RevokeDeviceResult>({
      deviceId: device.id,
      revokedAt: now,
      alreadyRevoked: false,
      revokedTokens,
    });
  },
});
