import { describe, expect, it } from "vitest";
import { escapeLike, normalizePhone, searchTerms } from "./rules";

describe("normalizePhone", () => {
  it.each([
    ["98765 43210", "9876543210"],
    ["+91 98765-43210", "9876543210"],
    ["09876543210", "09876543210"],
    ["919876543210", "9876543210"],
    ["(0712) 256-1234", "07122561234"],
    ["+44 20 7946 0958", "+442079460958"],
    ["123456", "123456"],
  ])("%s → %s", (typed, stored) => {
    expect(normalizePhone(typed)).toBe(stored);
  });

  it.each(["", "   ", "12345", "98765abc10", "++919876543210", "1".repeat(20), "98.76/54"])(
    "rejects %j",
    (typed) => {
      expect(normalizePhone(typed)).toBeNull();
    },
  );
});

describe("escapeLike", () => {
  it("escapes the LIKE wildcards and the escape character", () => {
    expect(escapeLike("50%_off\\x")).toBe("50\\%\\_off\\\\x");
  });
});

describe("searchTerms", () => {
  it("an empty box lists everything", () => {
    expect(searchTerms("   ").text).toBe("");
    expect(searchTerms(undefined).text).toBe("");
  });

  it("collapses spaces and normalises the code like the database", () => {
    const terms = searchTerms("  a   101 ");
    expect(terms.text).toBe("a 101");
    expect(terms.code).toBe("A 101");
    expect(terms.digits).toBeNull();
  });

  it("reads a typed phone number as its stored digits", () => {
    expect(searchTerms("+91 98765 43210").digits).toBe("9876543210");
    expect(searchTerms("98765").digits).toBe("98765");
    expect(searchTerms("ramesh").digits).toBeNull();
  });

  it("normalises a VC number like the database (no spaces or dashes) from 3 characters", () => {
    expect(searchTerms("0001 2345-6789").vc).toBe("000123456789");
    expect(searchTerms("ab").vc).toBeNull();
  });

  it("uses name contains from 2 characters and fuzzy names from 4", () => {
    expect(searchTerms("r")).toMatchObject({ nameContains: false, nameFuzzy: false });
    expect(searchTerms("ra")).toMatchObject({ nameContains: true, nameFuzzy: false });
    expect(searchTerms("ram")).toMatchObject({ nameContains: true, nameFuzzy: false });
    expect(searchTerms("rams")).toMatchObject({ nameContains: true, nameFuzzy: true });
  });

  it("cuts very long text", () => {
    expect(searchTerms("x".repeat(500)).text).toHaveLength(100);
  });
});
