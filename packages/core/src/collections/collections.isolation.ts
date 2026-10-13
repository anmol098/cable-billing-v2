/**
 * Tenant isolation cases for the collection services (T-062, PLAN §9.1, §16). Run by
 * src/testing/isolation.test.ts. Each tenant gets a lineman's day with a submitted handover.
 */
import { uuidv7 } from "@cb/db";
import { businessDate } from "@cb/domain";
import {
  defineIsolationCases,
  exemptFromIsolation,
  type IsolationSeedArgs,
} from "../testing/isolation";
import { getLinemanDay, getLinemenDay, getOwnCollectionDay } from "./day";
import { acceptHandover, returnHandover, submitHandover, submitHandoverInTx } from "./handover";

/** A past day, so the "future date" rule never interferes. */
const DAY = businessDate("2026-01-15");

async function seedSubmittedDay({ tx, tenant }: IsolationSeedArgs) {
  const submissionId = uuidv7();
  const submitted = await submitHandoverInTx(
    tx,
    { operatorId: tenant.operatorId, userId: tenant.users.lineman },
    {
      businessDate: DAY,
      submissionId,
      cashHandedOverPaise: 0,
      unsyncedPaymentCount: 0,
      unsyncedCashPaise: 0,
    },
    new Date(),
  );
  if (!submitted.ok) throw new Error(`seed handover: ${submitted.error.code}`);
  const sessionId = submitted.value.day.sessionId;
  if (!sessionId) throw new Error("seed handover: no session");
  return { sessionId, submissionId, linemanId: tenant.users.lineman };
}

export const linemenDayIsolation = defineIsolationCases(getLinemenDay, {
  seed: seedSubmittedDay,
  cases: [
    {
      name: "the Linemen page lists only the tenant's linemen and sessions",
      expect: "no_leak",
      input: () => ({ businessDate: DAY }),
    },
  ],
});

export const linemanDayIsolation = defineIsolationCases(getLinemanDay, {
  seed: seedSubmittedDay,
  cases: [
    {
      name: "open another tenant's lineman's day",
      input: (seed) => ({ linemanId: seed.linemanId, businessDate: DAY }),
    },
  ],
});

export const ownCollectionDayIsolation = defineIsolationCases(getOwnCollectionDay, {
  seed: seedSubmittedDay,
  cases: [
    {
      name: "a lineman's own day shows only their own session",
      expect: "no_leak",
      input: () => ({ businessDate: DAY }),
      // Owner/Staff have no session of their own, so the control ("own rows in the output") only
      // applies to the lineman; the services' tests cover Owner/Staff calling it.
      roles: ["lineman"],
    },
  ],
});

export const submitHandoverIsolation = exemptFromIsolation(
  submitHandover,
  "Its only id is the phone's own idempotency key (submissionId), which is scoped per tenant; " +
    "the collector is always ctx.userId and the day comes from the path, so there is no other " +
    "tenant's entity to name. handover.test.ts proves another tenant's submission id makes an " +
    "independent submission and leaves that tenant's rows untouched.",
);

export const acceptHandoverIsolation = defineIsolationCases(acceptHandover, {
  seed: seedSubmittedDay,
  cases: [
    {
      name: "accept another tenant's handover",
      input: (seed) => ({ sessionId: seed.sessionId, submissionId: seed.submissionId }),
    },
  ],
});

export const returnHandoverIsolation = defineIsolationCases(returnHandover, {
  seed: seedSubmittedDay,
  cases: [
    {
      name: "send back another tenant's handover",
      input: (seed) => ({
        sessionId: seed.sessionId,
        submissionId: seed.submissionId,
        note: "Count again",
      }),
    },
  ],
});
