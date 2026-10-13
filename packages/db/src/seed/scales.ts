/**
 * Seed scales (T-036, PRD §11 "Scale", PRD Appendix A).
 *
 * - `small`: a few tenants with enough history for every screen; seconds to seed. Dev default and
 *   Neon preview branches.
 * - `legacy`: the size of the legacy snapshot (PRD Appendix A: 8 operators, 7,616 customers,
 *   7,334 VC records, 146,224 invoices, 134 linemen). 146k invoices for 7.6k customers is about
 *   19 bills per customer; with customers joining and leaving during the window, **23 months** of
 *   history gives ≈148k invoices (`small` simulates 12 months, the scope's default).
 * - `10x`: ten times `legacy` (load testing, T-095).
 */

export const SEED_SCALES = ["small", "legacy", "10x"] as const;
export type SeedScale = (typeof SEED_SCALES)[number];

export interface ScaleConfig {
  readonly operators: number;
  /** Customers across all operators (spread unevenly). */
  readonly customers: number;
  /** Linemen across all operators. */
  readonly linemen: number;
  /** Months of billing history, ending with the month of `asOf`. */
  readonly months: number;
}

export const SCALE_CONFIGS: Readonly<Record<SeedScale, ScaleConfig>> = {
  small: { operators: 3, customers: 150, linemen: 6, months: 12 },
  legacy: { operators: 8, customers: 7_616, linemen: 134, months: 23 },
  "10x": { operators: 80, customers: 76_160, linemen: 1_340, months: 23 },
};

export function isSeedScale(value: unknown): value is SeedScale {
  return typeof value === "string" && (SEED_SCALES as readonly string[]).includes(value);
}
