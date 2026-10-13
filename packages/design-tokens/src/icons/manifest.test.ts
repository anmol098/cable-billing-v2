import { describe, expect, it } from "vitest";
import { androidDrawableName, IconManifestError, parseIconManifest } from "./manifest";

describe("parseIconManifest", () => {
  it("keeps the order of icons.json", () => {
    expect(parseIconManifest({ cash: "banknote", "log-out": "log-out" })).toEqual([
      { name: "cash", lucide: "banknote" },
      { name: "log-out", lucide: "log-out" },
    ]);
  });

  it("lists every problem", () => {
    let error: unknown;
    try {
      parseIconManifest({ Cash: "banknote", ok_name: "x", upi: 3, sms: "Message Square" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(IconManifestError);
    expect((error as IconManifestError).issues).toEqual([
      "Cash: icon names must be lowercase kebab-case (letters and digits, start with a letter)",
      "ok_name: icon names must be lowercase kebab-case (letters and digits, start with a letter)",
      'upi: the value must be a Lucide icon name such as "banknote"',
      'sms: the value must be a Lucide icon name such as "banknote"',
    ]);
  });

  it("rejects non-objects and empty manifests", () => {
    expect(() => parseIconManifest([])).toThrow("must be an object");
    expect(() => parseIconManifest(null)).toThrow("must be an object");
    expect(() => parseIconManifest({})).toThrow("at least one icon");
  });
});

describe("androidDrawableName", () => {
  it("prefixes ic_cb_ and snake-cases", () => {
    expect(androidDrawableName("cash")).toBe("ic_cb_cash");
    expect(androidDrawableName("log-out")).toBe("ic_cb_log_out");
    expect(androidDrawableName("volume-2")).toBe("ic_cb_volume_2");
  });
});
