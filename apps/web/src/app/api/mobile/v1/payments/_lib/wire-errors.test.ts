// @vitest-environment node
/**
 * `itemIdOf` decides which id a batch result echoes. The answer is checked against the contract
 * before it leaves (a mismatch is a 500 after earlier items were already saved), so it must accept
 * exactly the ids the contract's `Uuid` accepts and nothing more.
 */
import { Uuid } from "@cb/contracts";
import { describe, expect, it } from "vitest";
import { itemIdOf, UNUSABLE_ITEM_ID } from "./wire-errors";

describe("itemIdOf", () => {
  it("echoes an RFC UUID in lower case", () => {
    expect(itemIdOf({ id: "0192A3B4-C5D6-7E8F-9A0B-1C2D3E4F5A6B" })).toBe(
      "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b",
    );
  });

  it("answers the unusable id for anything the contract's Uuid refuses", () => {
    for (const id of [
      "12345678-1234-0234-0234-123456789abc", // version 0, variant 0
      "12345678-1234-4234-0234-123456789abc", // variant 0
      "12345678-1234-9234-a234-123456789abc", // version 9
      "6f9619ff-8b86-d011-b42d-00c04fc964ff", // version 13
      "12345678123442348234123456789abc", // no dashes
      "not-a-uuid",
      "",
      42,
      null,
      undefined,
    ]) {
      expect(itemIdOf({ id })).toBe(UNUSABLE_ITEM_ID);
    }
    expect(itemIdOf(null)).toBe(UNUSABLE_ITEM_ID);
    expect(itemIdOf("x")).toBe(UNUSABLE_ITEM_ID);
  });

  it("only ever returns ids the contract's Uuid accepts, and accepts exactly what it accepts", () => {
    const samples = [
      "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b",
      "0192A3B4-C5D6-7E8F-9A0B-1C2D3E4F5A6B",
      "12345678-1234-0234-0234-123456789abc",
      "12345678-1234-1234-8234-123456789abc",
      "12345678-1234-8234-b234-123456789abc",
      "12345678-1234-4234-c234-123456789abc",
      "00000000-0000-0000-0000-000000000000",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "6f9619ff-8b86-d011-b42d-00c04fc964ff",
    ];
    for (const id of samples) {
      const echoed = itemIdOf({ id });
      expect(Uuid.safeParse(echoed).success).toBe(true);
      expect(echoed === UNUSABLE_ITEM_ID).toBe(
        !Uuid.safeParse(id).success || id === UNUSABLE_ITEM_ID,
      );
    }
  });
});
