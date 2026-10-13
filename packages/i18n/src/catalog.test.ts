import { describe, expect, it } from "vitest";
import {
  buildAndroidEntries,
  buildWebMessages,
  type RawCatalog,
  stableJson,
  validateCatalog,
} from "./catalog";

function messages(raw: Partial<RawCatalog>): RawCatalog {
  return { en: {}, hi: {}, ...raw };
}

function errorsOf(raw: RawCatalog): string[] {
  return validateCatalog(raw).errors.map(
    (e) => `${e.file}${e.key ? ` ${e.key}` : ""}: ${e.message}`,
  );
}

describe("validateCatalog", () => {
  it("accepts a matching en + hi catalog", () => {
    const result = validateCatalog(
      messages({
        en: { common: { save: "Save", due: "₹{amount} due" } },
        hi: { common: { _review: ["save"], save: "सेव करें", due: "₹{amount} बाकी" } },
      }),
    );
    expect(result.errors).toEqual([]);
    expect(result.reviewCount).toBe(1);
  });

  it("fails when a Hindi key is missing", () => {
    expect(
      errorsOf(
        messages({
          en: { common: { save: "Save", back: "Back" } },
          hi: { common: { save: "सेव" } },
        }),
      ),
    ).toEqual(["hi/common.json back: missing translation (en/common.json has this key)"]);
  });

  it("fails when Hindi has a key English does not", () => {
    expect(
      errorsOf(
        messages({ en: { common: { save: "Save" } }, hi: { common: { save: "सेव", extra: "x" } } }),
      ),
    ).toEqual(["hi/common.json extra: key does not exist in en/common.json"]);
  });

  it("fails when a namespace file exists in one locale only", () => {
    expect(errorsOf(messages({ en: { bills: { title: "Bills" } } }))).toEqual([
      "hi/bills.json: file is missing; every locale needs every namespace",
    ]);
  });

  it("fails on placeholder mismatches", () => {
    const errors = errorsOf(
      messages({
        en: {
          bills: { due: "₹{amount} due", count: "{count, plural, one {# bill} other {# bills}}" },
        },
        hi: { bills: { due: "₹{amount} {name} बाकी", count: "{count} बिल" } },
      }),
    );
    expect(errors).toEqual([
      "hi/bills.json due: placeholders differ from en/bills.json: expected {amount:string}, found {amount:string, name:string}",
      "hi/bills.json count: placeholders differ from en/bills.json: expected {count:plural}, found {count:string}",
    ]);
  });

  it("fails on invalid ICU, a missing plural `other` and categories the locale never uses", () => {
    const errors = errorsOf(
      messages({
        en: {
          bills: {
            a: "Hello {name",
            b: "{n, plural, one {#}}",
            c: "{n, plural, one {#} other {#}}",
          },
        },
        hi: {
          bills: {
            a: "नमस्ते {name}",
            b: "{n, plural, one {#} other {#}}",
            c: "{n, plural, few {#} other {#}}",
          },
        },
      }),
    );
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/^en\/bills\.json a: invalid ICU message/);
    expect(errors[1]).toMatch(/^en\/bills\.json b: invalid ICU message/);
    expect(errors[2]).toMatch(
      /^hi\/bills\.json c: \{n, plural\} uses "few", which "hi" never selects/,
    );
  });

  it("checks _review lists", () => {
    expect(
      errorsOf(
        messages({
          en: { common: { _review: ["save"], save: "Save" } },
          hi: { common: { _review: ["save", "save", "gone"], save: "सेव" } },
        }),
      ),
    ).toEqual([
      "en/common.json _review: only translations carry a _review list",
      'hi/common.json _review: "save" is listed twice',
      'hi/common.json _review: "gone" is not a key in this file',
    ]);
  });

  it("checks names and value types", () => {
    expect(
      errorsOf(
        messages({
          en: { "Bad-Name": { a: "x" }, common: { BadKey: "x", n: 5, empty: " ", group: {} } },
          hi: { "Bad-Name": { a: "x" }, common: { BadKey: "x", n: 5, empty: " ", group: {} } },
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        "en/Bad-Name.json: namespace file name must be snake_case ([a-z][a-z0-9_]*.json)",
        'en/common.json BadKey: key segment "BadKey" must be snake_case ([a-z][a-z0-9_]*)',
        "en/common.json n: value must be a string (ICU message) or an object (group)",
        "en/common.json empty: message is empty",
        "en/common.json group: group is empty",
      ]),
    );
  });

  it("applies Android limits only to common and mobile_* namespaces", () => {
    const select = "{kind, select, cash {Cash} other {UPI}}";
    const hiSelect = "{kind, select, cash {नकद} other {UPI}}";
    expect(
      errorsOf(messages({ en: { bills: { m: select } }, hi: { bills: { m: hiSelect } } })),
    ).toEqual([]);
    const errors = errorsOf(
      messages({ en: { mobile_collect: { m: select } }, hi: { mobile_collect: { m: hiSelect } } }),
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/^en\/mobile_collect\.json m: Android: .*select/);
  });

  it("fails when two keys map to the same Android resource name", () => {
    const errors = errorsOf(
      messages({
        en: { common: { a_b: "x", a: { b: "y" } } },
        hi: { common: { a_b: "x", a: { b: "y" } } },
      }),
    );
    expect(errors).toEqual([
      'en/common.json a.b: Android resource name "common_a_b" clashes with common:a_b',
    ]);
  });
});

describe("merge into generated outputs", () => {
  const raw = messages({
    en: {
      common: { save: "Save", back: "Back", status: { saved: "Saved on phone" } },
      bills: { title: "Bills" },
      mobile_collect: { cash: "Cash" },
    },
    hi: {
      common: { _review: ["save"], save: "सेव करें", back: "पीछे", status: { saved: "फ़ोन में सेव" } },
      bills: { title: "बिल" },
      mobile_collect: { cash: "नकद" },
    },
  });

  it("merges every namespace into one next-intl file, keys sorted, without _review", () => {
    const { catalog, errors } = validateCatalog(raw);
    expect(errors).toEqual([]);
    const hi = buildWebMessages(catalog, "hi");
    expect(stableJson(hi)).toBe(
      stableJson({
        bills: { title: "बिल" },
        common: { back: "पीछे", save: "सेव करें", status: { saved: "फ़ोन में सेव" } },
        mobile_collect: { cash: "नकद" },
      }),
    );
    expect(Object.keys(hi)).toEqual(["bills", "common", "mobile_collect"]);
    expect(Object.keys(hi.common as object)).toEqual(["back", "save", "status"]);
  });

  it("is deterministic regardless of source key order", () => {
    const reversed = messages({
      en: Object.fromEntries(Object.entries(raw.en).reverse()),
      hi: Object.fromEntries(
        Object.entries(raw.hi)
          .reverse()
          .map(([ns, tree]) => [ns, Object.fromEntries(Object.entries(tree as object).reverse())]),
      ),
    });
    const a = validateCatalog(raw).catalog;
    const b = validateCatalog(reversed).catalog;
    expect(stableJson(buildWebMessages(b, "hi"))).toBe(stableJson(buildWebMessages(a, "hi")));
  });

  it("sends only common + mobile_* to Android, named ns_key", () => {
    const { catalog } = validateCatalog(raw);
    expect(
      buildAndroidEntries(catalog, "hi")
        .map((e) => e.name)
        .sort(),
    ).toEqual(["common_back", "common_save", "common_status_saved", "mobile_collect_cash"]);
  });
});
