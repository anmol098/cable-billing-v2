/**
 * Who the virtual users are: the T-036 seed's logins, derived from the same plan the seed uses
 * (`planOperators`), so the tool knows every operator's owner, staff and active linemen without
 * reading the target's database and without guessing logins (every wrong guess would spend a
 * sign-in from the rate limit).
 */
import { planOperators, SCALE_CONFIGS, type SeedScale } from "@cb/db/seed";

export interface OperatorPersonas {
  /** 1-based, as in the logins (`seed-op05-…`). */
  readonly number: number;
  readonly name: string;
  readonly customers: number;
  readonly owner: string;
  readonly staff: readonly string[];
  /** Active linemen only (the seed disables the last lineman of an operator with ≥ 4). */
  readonly linemen: readonly string[];
}

const pad = (value: number) => String(value).padStart(2, "0");

/** The seed's users for (scale, seed); mirrors `packages/db/src/seed/generate.ts` (users section). */
export function seedPersonas(scale: SeedScale, seed = "1"): OperatorPersonas[] {
  return planOperators(SCALE_CONFIGS[scale], seed).map((spec) => {
    const tag = pad(spec.index + 1);
    const lineCount = Math.max(1, spec.linemen);
    const active = lineCount >= 4 ? lineCount - 1 : lineCount;
    return {
      number: spec.index + 1,
      name: spec.name,
      customers: spec.customers,
      owner: `seed-op${tag}-owner`,
      staff:
        spec.customers >= 500
          ? [`seed-op${tag}-staff1`, `seed-op${tag}-staff2`]
          : [`seed-op${tag}-staff1`],
      linemen: Array.from({ length: active }, (_, i) => `seed-op${tag}-lineman${pad(i + 1)}`),
    };
  });
}

/**
 * Picks `count` items round-robin across operators (operator 1's first, operator 2's first, …,
 * then everyone's second), so a small run still touches every tenant.
 */
export function spread<T>(groups: ReadonlyArray<readonly T[]>, count: number): T[] {
  const picked: T[] = [];
  for (let round = 0; picked.length < count; round += 1) {
    let added = false;
    for (const group of groups) {
      const item = group[round];
      if (item === undefined) continue;
      picked.push(item);
      added = true;
      if (picked.length === count) break;
    }
    if (!added) break;
  }
  return picked;
}
