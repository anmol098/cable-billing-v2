import { describe, expect, it } from "vitest";
import {
  describeFindings,
  ForbiddenValues,
  normalizeForMatch,
  scanForPii,
  shapeFindings,
} from "./scan";

describe("shape checks", () => {
  it.each([
    ["9876543210", "phone"],
    ["call +91 98765 43210 now", "phone"],
    ["+91-9876543210", "phone"],
    ["09876543210", "phone"],
    ["ravi.k@example.com", "email"],
    ["5f4dcc3b5aa765d61d8327deb882cf99", "secret"],
    ["$2y$10$abcdefghijklmnopqrstuv", "secret"],
    ["$argon2id$v=19$m=65536", "secret"],
    ["1234 5678 9012", "digits"],
    ["123456789012", "digits"],
  ])("finds %s", (text, kind) => {
    expect(shapeFindings(text)).toContain(kind);
  });

  it.each([
    "| `invoice` | yes | 146,224 | 146,224 | 0 | 13 |",
    "| Generated (UTC) | 2026-10-13T04:30:00.000Z |",
    "| `vc.start_date` | `date` | 0 | 0 | 6 | 0 | 2017-01-03 | 2023-12-28 |",
    "#1 from `mariadb 127.0.0.1:3307/legacy`",
    "| `costumer.status` | `varchar(20)` |",
    "| 7 (not in operator table) | 1,234,567 |",
  ])("leaves report lines alone: %s", (line) => {
    expect(shapeFindings(line)).toEqual([]);
  });
});

describe("value checks", () => {
  const forbidden = new ForbiddenValues();
  forbidden.addValue("Sunita Devi", "costumer.name");
  forbidden.addNameWords("Sunita Devi", "costumer.name");
  forbidden.addValue("H.No 12, Shastri Nagar, Ward 4, Rampur", "costumer.address");
  forbidden.addValue("ramesh@4821", "lineman.password");
  forbidden.addValue("123", "lineman.password"); // too short: ignored
  forbidden.addValue("560001", "costumer.pincode"); // short digit runs: ignored (counts look alike)
  forbidden.addValue(
    "a very long free text address with more than twelve words in it near the old temple",
    "costumer.address",
  );
  forbidden.addIgnored("status");
  forbidden.addValue("status", "lineman.password"); // equal to an identifier: ignored

  it("normalises case and punctuation", () => {
    expect(normalizeForMatch("  H.No 12,  Shastri-Nagar ")).toBe("h no 12 shastri nagar");
  });

  it("finds whole values and person-name words", () => {
    expect(scanForPii("| SUNITA-DEVI |", forbidden)).toEqual([
      { line: 1, kind: "value", source: "costumer.name" },
    ]);
    expect(scanForPii("x\n`sunita`", forbidden)).toEqual([
      { line: 2, kind: "value", source: "costumer.name" },
    ]);
    expect(scanForPii("h no 12 shastri nagar ward 4 rampur", forbidden)).toHaveLength(1);
    expect(scanForPii("password was Ramesh@4821!", forbidden)).toHaveLength(1);
    expect(
      scanForPii("A very long free-text address with more than twelve words in it", forbidden),
    ).toHaveLength(1);
  });

  it("does not match inside other words, short values or identifiers", () => {
    expect(scanForPii("Sunitapur devidas", forbidden)).toEqual([]);
    expect(scanForPii("| 123 | 560001 | status |", forbidden)).toEqual([]);
  });

  it("describes findings without repeating the value", () => {
    const text = describeFindings(scanForPii("Sunita Devi 9876543210", forbidden));
    expect(text).toContain("line 1");
    expect(text).not.toMatch(/sunita|9876543210/i);
  });
});
