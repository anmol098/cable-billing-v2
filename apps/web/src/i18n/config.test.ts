import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import hi from "../../messages/hi.json";
import { isLocale, resolveLocale } from "./config";

describe("locale config", () => {
  it("accepts only the shipped locales", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("hi")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  it("falls back to English, the web default", () => {
    expect(resolveLocale(undefined)).toBe("en");
    expect(resolveLocale("xx")).toBe("en");
    expect(resolveLocale("hi")).toBe("hi");
  });

  it("has generated messages with the same namespaces for both locales", () => {
    expect(Object.keys(hi).sort()).toEqual(Object.keys(en).sort());
    expect(en.scaffold.home.placeholder).toBeTruthy();
    expect(hi.common.app_name).toBe("केबल बिलिंग");
  });
});
