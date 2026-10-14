/**
 * Tenant isolation cases for team management (T-032, PLAN §9.1, §16). Run by
 * src/testing/isolation.test.ts: the Owner of tenant A naming tenant B's lineman gets NOT_FOUND
 * and nothing changes anywhere; A's team list never shows B's people or phones.
 */
import { users } from "@cb/db";
import { eq } from "drizzle-orm";
import { defineIsolationCases, exemptFromIsolation } from "../testing/isolation";
import {
  addLineman,
  addStaff,
  deactivateMember,
  listTeam,
  reactivateMember,
  resetMemberPassword,
} from "./team";

export const listTeamIsolation = defineIsolationCases(listTeam, {
  seed: async ({ tenant }) => ({ linemanId: tenant.users.lineman, deviceId: tenant.deviceId }),
  cases: [
    {
      name: "the team list shows only the tenant's people and phones",
      expect: "no_leak",
      input: () => ({}),
    },
  ],
});

export const resetMemberPasswordIsolation = defineIsolationCases(resetMemberPassword, {
  seed: async ({ tenant }) => ({ linemanId: tenant.users.lineman }),
  cases: [
    {
      name: "set a new password for another tenant's lineman",
      input: (seed) => ({ userId: seed.linemanId, password: "river 2468" }),
    },
  ],
});

export const deactivateMemberIsolation = defineIsolationCases(deactivateMember, {
  seed: async ({ tenant }) => ({ linemanId: tenant.users.lineman }),
  cases: [
    {
      name: "switch off another tenant's lineman",
      input: (seed) => ({ userId: seed.linemanId }),
    },
  ],
});

export const reactivateMemberIsolation = defineIsolationCases(reactivateMember, {
  // Switched off first, so the control call really changes something.
  seed: async ({ tx, tenant }) => {
    await tx.update(users).set({ status: "disabled" }).where(eq(users.id, tenant.users.lineman));
    return { linemanId: tenant.users.lineman };
  },
  cases: [
    {
      name: "switch on another tenant's lineman",
      input: (seed) => ({ userId: seed.linemanId }),
    },
  ],
});

const ADD_REASON =
  "Its input names no existing entity: the new user is always created in ctx.operatorId (never " +
  "from the input). The one cross-tenant path, a sign-in name already used by another business " +
  "(names are unique everywhere), is covered in team.test.ts: the call moves on to `-2` (or " +
  "answers login_taken) without any id, name or detail of the other tenant, and changes nothing there.";

export const addLinemanIsolation = exemptFromIsolation(addLineman, ADD_REASON);
export const addStaffIsolation = exemptFromIsolation(addStaff, ADD_REASON);
