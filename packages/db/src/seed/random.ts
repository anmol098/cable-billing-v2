/**
 * Seeded pseudo-random numbers for the seed generator (T-036). Everything the generator draws comes
 * from here, so the same seed always gives the same data. Not for anything security-related.
 *
 * `sfc32` (Chris Doty-Humphrey's Small Fast Counter) seeded through `cyrb128`, a string hash: both
 * are tiny, fast and well distributed, and `fork(label)` gives an independent stream per operator,
 * so operators can be generated in any order (or concurrently) with the same result.
 */

/** 128-bit string hash (four 32-bit words), used only to seed {@link Rng}. */
function cyrb128(text: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i += 1) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  private readonly label: string;

  constructor(seed: string | number) {
    this.label = String(seed);
    [this.a, this.b, this.c, this.d] = cyrb128(this.label);
    // Warm up: the first outputs of sfc32 are correlated with the seed words.
    for (let i = 0; i < 15; i += 1) this.nextUint32();
  }

  /** An independent stream derived from this one's seed and `label` (not from its position). */
  fork(label: string | number): Rng {
    return new Rng(`${this.label}/${label}`);
  }

  /** Uniform 32-bit unsigned integer. */
  nextUint32(): number {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform integer in [min, max] (both inclusive). */
  int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new RangeError(`Rng.int: invalid range [${min}, ${max}]`);
    }
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** A uniformly chosen element. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("Rng.pick: empty list");
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** An element chosen with the given weights (≥ 0, not all 0). */
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((sum, [, w]) => sum + w, 0);
    if (!(total > 0)) throw new RangeError("Rng.weighted: weights must add up to more than 0");
    let r = this.next() * total;
    for (const [item, w] of items) {
      r -= w;
      if (r < 0) return item;
    }
    return (items[items.length - 1] as readonly [T, number])[0];
  }

  /** A shuffled copy (Fisher–Yates). */
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
    }
    return copy;
  }

  /** `count` decimal digits (leading zeros allowed). */
  digits(count: number): string {
    let out = "";
    for (let i = 0; i < count; i += 1) out += String(this.int(0, 9));
    return out;
  }

  /** Fills `bytes` with random bytes (for the seeded UUIDv7 generator). */
  fill(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i += 4) {
      let word = this.nextUint32();
      for (let j = i; j < Math.min(i + 4, bytes.length); j += 1) {
        bytes[j] = word & 0xff;
        word >>>= 8;
      }
    }
  }
}
