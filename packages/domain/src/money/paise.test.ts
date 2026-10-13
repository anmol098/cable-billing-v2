import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  absPaise,
  addPaise,
  comparePaise,
  isPaise,
  isWholeRupees,
  MAX_INPUT_RUPEES,
  maxPaise,
  minPaise,
  multiplyPaise,
  negatePaise,
  type Paise,
  paise,
  paiseToBigInt,
  rupeesToPaise,
  splitRupees,
  subtractPaise,
  sumPaise,
  toPaise,
} from "./paise";

const MAX = Number.MAX_SAFE_INTEGER;
const anyPaise = fc.maxSafeInteger().map(paise);

describe("paise()", () => {
  it("accepts safe integers of any sign", () => {
    expect(paise(0)).toBe(0);
    expect(paise(12_345)).toBe(12_345);
    expect(paise(-500)).toBe(-500);
    expect(paise(MAX)).toBe(MAX);
    expect(Object.is(paise(-0), 0)).toBe(true);
  });

  it.each([0.5, 12.5, Number.NaN, Number.POSITIVE_INFINITY, MAX + 1, -(MAX + 1)])(
    "refuses %s",
    (value) => {
      expect(() => paise(value)).toThrow(RangeError);
    },
  );

  it("isPaise matches", () => {
    expect(isPaise(100)).toBe(true);
    expect(isPaise(1.5)).toBe(false);
    expect(isPaise("100")).toBe(false);
    expect(isPaise(100n)).toBe(false);
  });
});

describe("toPaise() (DB bigint values)", () => {
  it("reads numbers, bigints and integer strings", () => {
    expect(toPaise(45_000)).toBe(45_000);
    expect(toPaise(45_000n)).toBe(45_000);
    expect(toPaise("45000")).toBe(45_000);
    expect(toPaise("-12500")).toBe(-12_500);
    expect(toPaise(BigInt(MAX))).toBe(MAX);
  });

  it.each(["12.50", "1e3", "", " 1", "abc", "0x10"])("refuses the string %j", (value) => {
    expect(() => toPaise(value)).toThrow(RangeError);
  });

  it("refuses values beyond the safe range", () => {
    expect(() => toPaise(BigInt(MAX) + 1n)).toThrow(RangeError);
    expect(() => toPaise(-(BigInt(MAX) + 1n))).toThrow(RangeError);
    expect(() => toPaise("9007199254740993")).toThrow(RangeError);
  });

  it("round-trips through bigint and string", () => {
    fc.assert(
      fc.property(anyPaise, (amount) => {
        expect(toPaise(paiseToBigInt(amount))).toBe(amount);
        expect(toPaise(String(amount))).toBe(amount);
        expect(toPaise(paiseToBigInt(amount).toString())).toBe(amount);
      }),
    );
  });
});

describe("rupeesToPaise() (D-17: whole rupees only)", () => {
  it("multiplies whole rupees by 100", () => {
    expect(rupeesToPaise(0)).toBe(0);
    expect(rupeesToPaise(450)).toBe(45_000);
    expect(rupeesToPaise(MAX_INPUT_RUPEES)).toBe(999_999_999_999_900);
  });

  it.each([12.5, -1, Number.NaN, MAX_INPUT_RUPEES + 1])("refuses %s", (value) => {
    expect(() => rupeesToPaise(value)).toThrow(RangeError);
  });

  it("is exact and whole for every allowed input", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_INPUT_RUPEES }), (rupees) => {
        const amount = rupeesToPaise(rupees);
        expect(Number.isSafeInteger(amount)).toBe(true);
        expect(isWholeRupees(amount)).toBe(true);
        expect(splitRupees(amount)).toEqual({ rupees, paise: 0 });
        expect(paiseToBigInt(amount)).toBe(BigInt(rupees) * 100n);
      }),
    );
  });
});

describe("splitRupees()", () => {
  it("splits with the sign on both parts", () => {
    expect(splitRupees(paise(12_345))).toEqual({ rupees: 123, paise: 45 });
    expect(splitRupees(paise(-12_345))).toEqual({ rupees: -123, paise: -45 });
    expect(splitRupees(paise(99))).toEqual({ rupees: 0, paise: 99 });
    expect(splitRupees(paise(0))).toEqual({ rupees: 0, paise: 0 });
  });

  it("recombines to the original amount", () => {
    fc.assert(
      fc.property(anyPaise, (amount) => {
        const { rupees, paise: rest } = splitRupees(amount);
        expect(BigInt(rupees) * 100n + BigInt(rest)).toBe(BigInt(amount));
        expect(Math.abs(rest)).toBeLessThan(100);
      }),
    );
  });
});

describe("arithmetic", () => {
  const small = fc.integer({ min: -1e12, max: 1e12 }).map(paise);

  it("adds, subtracts, negates and multiplies exactly", () => {
    expect(addPaise(paise(45_000), paise(-5_000))).toBe(40_000);
    expect(subtractPaise(paise(45_000), paise(50_000))).toBe(-5_000);
    expect(negatePaise(paise(100))).toBe(-100);
    expect(Object.is(negatePaise(paise(0)), 0)).toBe(true);
    expect(absPaise(paise(-100))).toBe(100);
    expect(multiplyPaise(paise(45_000), 128)).toBe(5_760_000);
    expect(minPaise(paise(1), paise(2))).toBe(1);
    expect(maxPaise(paise(1), paise(2))).toBe(2);
  });

  it("sums (empty is zero)", () => {
    expect(sumPaise([])).toBe(0);
    expect(sumPaise([paise(100), paise(250), paise(-50)])).toBe(300);
    expect(sumPaise(new Set([paise(1), paise(2)]))).toBe(3);
  });

  it("throws on overflow instead of rounding", () => {
    expect(() => addPaise(paise(MAX), paise(1))).toThrow(RangeError);
    expect(() => subtractPaise(paise(-MAX), paise(1))).toThrow(RangeError);
    expect(() => sumPaise([paise(MAX), paise(MAX)])).toThrow(RangeError);
    expect(() => multiplyPaise(paise(MAX), 2)).toThrow(RangeError);
    expect(() => multiplyPaise(paise(100), 1.5)).toThrow(RangeError);
  });

  it("agrees with bigint arithmetic (properties)", () => {
    fc.assert(
      fc.property(small, small, (a, b) => {
        expect(BigInt(addPaise(a, b))).toBe(BigInt(a) + BigInt(b));
        expect(BigInt(subtractPaise(a, b))).toBe(BigInt(a) - BigInt(b));
        expect(addPaise(subtractPaise(a, b), b)).toBe(a);
        expect(sumPaise([a, b, negatePaise(b)])).toBe(a);
      }),
    );
    fc.assert(
      fc.property(small, fc.integer({ min: -1000, max: 1000 }), (a, n) => {
        expect(BigInt(multiplyPaise(a, n))).toBe(BigInt(a) * BigInt(n));
      }),
    );
  });

  it("sorts ascending with comparePaise", () => {
    const amounts: Paise[] = [paise(300), paise(-5), paise(0), paise(300), paise(12)];
    expect([...amounts].sort(comparePaise)).toEqual([-5, 0, 12, 300, 300]);
  });
});
