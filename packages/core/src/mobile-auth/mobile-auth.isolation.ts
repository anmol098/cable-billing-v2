/**
 * Tenant isolation cases for "Sign out this phone" (T-028, PLAN §9.1, §16). Run by
 * src/testing/isolation.test.ts: the Owner of tenant A revoking tenant B's device gets NOT_FOUND
 * and nothing changes anywhere (B's device stays signed in, its tokens stay live).
 */
import { mobileRefreshTokens, uuidv7 } from "@cb/db";
import { defineIsolationCases } from "../testing/isolation";
import { revokeDevice } from "./revoke";
import { hashRefreshToken, newRefreshToken } from "./tokens";

export const revokeDeviceIsolation = defineIsolationCases(revokeDevice, {
  seed: async ({ tx, tenant }) => {
    // A live refresh token on the tenant's lineman device, so an attack would have something to revoke.
    const familyId = uuidv7();
    const now = new Date();
    await tx.insert(mobileRefreshTokens).values({
      id: familyId,
      operatorId: tenant.operatorId,
      userId: tenant.users.lineman,
      deviceId: tenant.deviceId,
      familyId,
      parentId: null,
      tokenHash: hashRefreshToken(newRefreshToken()),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 86_400_000),
    });
    return { deviceId: tenant.deviceId };
  },
  cases: [
    {
      name: "sign out another tenant's phone",
      input: (seed) => ({ deviceId: seed.deviceId }),
    },
  ],
});
