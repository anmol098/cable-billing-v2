import { describe, expect, it } from "vitest";
import { Rng } from "./random";

const draw = (rng: Rng, n: number) => Array.from({ length: n }, () => rng.nextUint32());

describe("Rng", () => {
  it("gives the same sequence for the same seed and a different one for another seed", () => {
    expect(draw(new Rng(42), 20)).toEqual(draw(new Rng("42"), 20));
    expect(draw(new Rng(42), 20)).not.toEqual(draw(new Rng(43), 20));
  });

  it("forks streams that depend on the label, not on how much the parent was used", () => {
    const a = new Rng("seed");
    const b = new Rng("seed");
    draw(b, 100);
    expect(draw(a.fork("op-1"), 10)).toEqual(draw(b.fork("op-1"), 10));
    expect(draw(a.fork("op-1"), 10)).not.toEqual(draw(a.fork("op-2"), 10));
  });

  it("keeps values in range", () => {
    const rng = new Rng(7);
    for (let i = 0; i < 2_000; i += 1) {
      const n = rng.int(-3, 5);
      expect(n).toBeGreaterThanOrEqual(-3);
      expect(n).toBeLessThanOrEqual(5);
      const x = rng.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(rng.digits(12)).toMatch(/^\d{12}$/);
    expect(() => rng.int(2, 1)).toThrow(RangeError);
    expect(() => rng.pick([])).toThrow(RangeError);
  });

  it("covers every value of a small range and respects weights", () => {
    const rng = new Rng(1);
    const seen = new Set(Array.from({ length: 500 }, () => rng.int(1, 6)));
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    const picks = Array.from({ length: 2_000 }, () =>
      rng.weighted([
        ["often", 9],
        ["never", 0],
        ["rarely", 1],
      ] as const),
    );
    expect(picks).not.toContain("never");
    expect(picks.filter((p) => p === "often").length).toBeGreaterThan(1_600);
  });

  it("shuffles without losing elements and fills bytes", () => {
    const rng = new Rng(3);
    expect(rng.shuffle([1, 2, 3, 4, 5]).sort()).toEqual([1, 2, 3, 4, 5]);
    const bytes = new Uint8Array(10);
    rng.fill(bytes);
    expect(bytes.some((b) => b !== 0)).toBe(true);
  });
});
