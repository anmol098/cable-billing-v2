import { describe, expect, it } from "vitest";
import { packageName } from "./index";

describe("@cb/i18n", () => {
  it("is wired into Vitest", () => {
    expect(packageName).toBe("@cb/i18n");
  });
});
