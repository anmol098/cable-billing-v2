import { describe, expect, it } from "vitest";
import { toPg } from "./copy";
import { pgColumnType, quotePgIdent } from "./types";

describe("pgColumnType", () => {
  it.each([
    ["int", "int(11)", "integer", "bigint"],
    ["tinyint", "tinyint(1)", "integer", "bigint"],
    ["bigint", "bigint(20) unsigned", "integer", "numeric(20)"],
    ["float", "float", "float", "double precision"],
    ["double", "double", "float", "double precision"],
    ["decimal", "decimal(10,2)", "decimal", "numeric"],
    ["date", "date", "temporal", "text"],
    ["datetime", "datetime", "temporal", "text"],
    ["timestamp", "timestamp", "temporal", "text"],
    ["year", "year(4)", "temporal", "text"],
    ["varchar", "varchar(20)", "text", "text"],
    ["enum", "enum('a','b')", "text", "text"],
    ["blob", "blob", "binary", "bytea"],
    ["bit", "bit(1)", "binary", "bytea"],
  ])("%s (%s) → %s %s", (dataType, columnType, kind, pgType) => {
    expect(pgColumnType({ dataType, columnType })).toEqual({ kind, pgType });
  });
});

describe("toPg", () => {
  it("keeps zero dates and raw text", () => {
    expect(toPg("0000-00-00", "temporal")).toEqual({ value: "0000-00-00", nulBytes: false });
    expect(toPg(2019, "temporal")).toEqual({ value: "2019", nulBytes: false });
  });

  it("removes NUL characters from text and counts them", () => {
    expect(toPg("a\0b", "text")).toEqual({ value: "ab", nulBytes: true });
  });

  it("passes numbers, big integers, buffers and nulls", () => {
    expect(toPg(249.99, "float").value).toBe(249.99);
    expect(toPg(18446744073709551615n, "integer").value).toBe("18446744073709551615");
    expect(toPg(Buffer.from([1]), "binary").value).toEqual(Buffer.from([1]));
    expect(toPg(null, "text").value).toBeNull();
  });
});

describe("quotePgIdent", () => {
  it("keeps case and escapes quotes", () => {
    expect(quotePgIdent("isReceipt")).toBe('"isReceipt"');
    expect(quotePgIdent('a"b')).toBe('"a""b"');
    expect(() => quotePgIdent("")).toThrow();
  });
});
