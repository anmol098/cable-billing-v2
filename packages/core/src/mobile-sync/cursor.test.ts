/** The roster cursor's encoding (T-060): round trip, size, and refusal of anything else. */
import { Cursor } from "@cb/contracts";
import { describe, expect, it } from "vitest";
import {
  cursorIsFromTheFuture,
  decodeCursor,
  encodeCursor,
  fullSyncCursor,
  minXid,
  type RosterCursor,
} from "./cursor";

const OP = "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b";
const CUSTOMER = "0192a3b4-c5d6-7e8f-9a0b-ffffffffffff";

describe("roster cursor", () => {
  it("round-trips every shape and stays within the contract's 512 characters", () => {
    const shapes: RosterCursor[] = [
      fullSyncCursor(OP),
      { operatorId: OP, watermark: "123456", full: false },
      {
        operatorId: OP,
        watermark: "18446744073709551615",
        nextWatermark: "18446744073709551615",
        after: ["18446744073709551615", CUSTOMER],
        full: true,
      },
    ];
    for (const cursor of shapes) {
      const text = encodeCursor(cursor);
      expect(Cursor.safeParse(text).success).toBe(true);
      expect(text.length).toBeLessThanOrEqual(512);
      expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeCursor(text)).toEqual(cursor);
    }
  });

  it("refuses text that is not one of its cursors", () => {
    const raw = (body: unknown) => Buffer.from(JSON.stringify(body)).toString("base64url");
    for (const text of [
      "",
      "a b",
      "!!!",
      "x".repeat(600),
      raw("cursor"),
      raw({ v: 2, o: OP, w: "1" }),
      raw({ v: 1, o: "not-a-uuid", w: "1" }),
      raw({ v: 1, o: OP, w: "01" }),
      raw({ v: 1, o: OP, w: "-5" }),
      raw({ v: 1, o: OP, w: "1", k: ["1"] }),
      raw({ v: 1, o: OP, w: "1", extra: true }),
      raw({ v: 1, o: OP, w: "1", f: 2 }),
    ]) {
      expect(decodeCursor(text)).toBeNull();
    }
  });

  it("compares xids as 64-bit numbers", () => {
    expect(minXid("9", "10")).toBe("9");
    expect(minXid("18446744073709551615", "18446744073709551614")).toBe("18446744073709551614");
    const cursor = {
      operatorId: OP,
      watermark: "5",
      after: ["11", CUSTOMER] as const,
      full: false,
    };
    expect(cursorIsFromTheFuture(cursor, "10")).toBe(true);
    expect(cursorIsFromTheFuture(cursor, "11")).toBe(false);
  });
});
