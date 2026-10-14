/**
 * Load shapes. A profile says how many virtual users do what; `--seed-scale` says which seed the
 * target holds (whose logins exist). Numbers are per run and come from the legacy baseline
 * (PRD Appendix A: 8 operators, 7,616 customers, 134 linemen) and PLAN §10 (50 payments per batch,
 * 500 customers per roster page).
 */
import type { SeedScale } from "@cb/db/seed";

export const PROFILE_NAMES = ["smoke", "legacy", "10x"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

export function isProfileName(value: unknown): value is ProfileName {
  return typeof value === "string" && (PROFILE_NAMES as readonly string[]).includes(value);
}

export interface Profile {
  readonly name: ProfileName;
  /** The seed scale assumed when `--seed-scale` is not given. */
  readonly seedScale: SeedScale;
  /** Phones syncing / pushing at the same moment (the morning and evening bursts). */
  readonly linemen: number;
  /** After the morning full sync: rounds of (customer detail + delta sync) per phone. */
  readonly syncRounds: number;
  /** Evening push: batches per phone, and payments per batch (contract max 50). */
  readonly paymentBatches: number;
  readonly paymentsPerBatch: number;
  /** Counter clerks (one Staff per operator, round-robin) and payments each. */
  readonly counterUsers: number;
  readonly counterPayments: number;
  /** Office users reading lists and reports (Owners and Staff), and passes over the page list. */
  readonly webUsers: number;
  readonly webRounds: number;
  /** Owners downloading files, and files each (server limit 30 per person per 15 min). */
  readonly exportOwners: number;
  readonly exportsPerOwner: number;
  /** Give up waiting for the billing run after this long. */
  readonly billingTimeoutMinutes: number;
}

export const PROFILES: Readonly<Record<ProfileName, Profile>> = {
  /** Proves the tooling end to end; a handful of users. Not a load. */
  smoke: {
    name: "smoke",
    seedScale: "legacy",
    linemen: 4,
    syncRounds: 2,
    paymentBatches: 1,
    paymentsPerBatch: 10,
    counterUsers: 2,
    counterPayments: 3,
    webUsers: 2,
    webRounds: 1,
    exportOwners: 2,
    exportsPerOwner: 2,
    billingTimeoutMinutes: 30,
  },
  /**
   * Legacy scale at its daily peaks: about half the linemen open the app in the same minute in the
   * morning and push full 50-payment batches together in the evening, while every operator's
   * counter and office are busy. 76 sign-ins: fits one 15-minute window.
   */
  legacy: {
    name: "legacy",
    seedScale: "legacy",
    linemen: 60,
    syncRounds: 5,
    paymentBatches: 2,
    paymentsPerBatch: 50,
    counterUsers: 8,
    counterPayments: 10,
    webUsers: 16,
    webRounds: 3,
    exportOwners: 8,
    exportsPerOwner: 3,
    billingTimeoutMinutes: 45,
  },
  /**
   * Ten times the legacy business (80 operators). Needs ≈ 420 signed-in users: warm the session
   * cache first (`load warm --profile 10x`, once per 15 minutes until it reports none missing).
   */
  "10x": {
    name: "10x",
    seedScale: "10x",
    linemen: 300,
    syncRounds: 5,
    paymentBatches: 2,
    paymentsPerBatch: 50,
    counterUsers: 40,
    counterPayments: 10,
    webUsers: 80,
    webRounds: 3,
    exportOwners: 20,
    exportsPerOwner: 3,
    billingTimeoutMinutes: 330,
  },
};
