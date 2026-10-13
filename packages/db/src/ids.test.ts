import { describe, expect, it } from "vitest";
import { createUuidV7Generator, isUuid, isUuidV7, uuidV7Timestamp, uuidv7 } from "./ids";

const zeros = (bytes: Uint8Array) => bytes.fill(0);
const ones = (bytes: Uint8Array) => bytes.fill(0xff);
const strictlyIncreasing = (ids: string[]) =>
  ids.every((id, i) => i === 0 || (ids[i - 1] ?? "") < id);

describe("uuidv7", () => {
  it("is a well-formed version 7, RFC-variant UUID", () => {
    for (let i = 0; i < 1000; i += 1) {
      const id = uuidv7();
      expect(isUuidV7(id)).toBe(true);
      expect(id).toBe(id.toLowerCase());
    }
  });

  it("embeds the creation time in milliseconds", () => {
    const at = Date.UTC(2026, 9, 13, 4, 30, 0, 123);
    const next = createUuidV7Generator({ now: () => at });
    const id = next();
    expect(uuidV7Timestamp(id).getTime()).toBe(at);
    expect(
      id.startsWith(
        at
          .toString(16)
          .padStart(12, "0")
          .replace(/^(.{8})/, "$1-"),
      ),
    ).toBe(true);
  });

  it("is strictly increasing within one process, also within a single millisecond", () => {
    const ids = Array.from({ length: 20_000 }, () => uuidv7());
    expect(strictlyIncreasing(ids)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("stays increasing on a frozen clock past the 12-bit counter, by carrying into the timestamp", () => {
    const at = 1_800_000_000_000;
    const next = createUuidV7Generator({ now: () => at, random: ones });
    const ids = Array.from({ length: 5000 }, () => next());
    expect(strictlyIncreasing(ids)).toBe(true);
    // Seeded at 0x7ff with all-ones randomness: 2049 ids fit in `at`, then it borrows `at + 1`, …
    expect(uuidV7Timestamp(ids[0] ?? "").getTime()).toBe(at);
    expect(uuidV7Timestamp(ids[2048] ?? "").getTime()).toBe(at);
    expect(uuidV7Timestamp(ids[2049] ?? "").getTime()).toBe(at + 1);
  });

  it("never goes backwards when the clock does", () => {
    let clock = 2_000_000;
    const next = createUuidV7Generator({ now: () => clock, random: zeros });
    const a = next();
    clock -= 1000;
    const b = next();
    clock += 5000;
    const c = next();
    expect(a < b && b < c).toBe(true);
    expect(uuidV7Timestamp(b).getTime()).toBe(2_000_000);
    expect(uuidV7Timestamp(c).getTime()).toBe(2_004_000);
  });

  it("sets version and variant bits regardless of the random bytes", () => {
    expect(isUuidV7(createUuidV7Generator({ random: ones })())).toBe(true);
    expect(isUuidV7(createUuidV7Generator({ random: zeros })())).toBe(true);
  });

  it("rejects clocks outside the 48-bit range", () => {
    expect(() => createUuidV7Generator({ now: () => -1 })()).toThrow(RangeError);
    expect(() => createUuidV7Generator({ now: () => 2 ** 48 })()).toThrow(RangeError);
  });
});

describe("isUuid / uuidV7Timestamp", () => {
  it("accepts any UUID version and rejects other strings", () => {
    expect(isUuid("6f9619ff-8b86-d011-b42d-00c04fc964ff")).toBe(true);
    expect(isUuid("6F9619FF-8B86-D011-B42D-00C04FC964FF")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("6f9619ff8b86d011b42d00c04fc964ff")).toBe(false);
    expect(isUuid("6f9619ff-8b86-d011-b42d-00c04fc964ff' or 1=1 --")).toBe(false);
    expect(isUuid(42)).toBe(false);
  });

  it("only reads timestamps from UUIDv7", () => {
    expect(() => uuidV7Timestamp("6f9619ff-8b86-d011-b42d-00c04fc964ff")).toThrow(TypeError);
  });
});
