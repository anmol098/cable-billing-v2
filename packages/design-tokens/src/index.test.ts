import { describe, expect, it } from "vitest";
import { packageName } from "./index";

describe("@cb/design-tokens", () => {
  it("is wired into Vitest", () => {
    expect(packageName).toBe("@cb/design-tokens");
  });
});
