import { describe, expect, it } from "vitest";
import { packageName } from "./index";

describe("@cb/core", () => {
  it("is wired into Vitest", () => {
    expect(packageName).toBe("@cb/core");
  });
});
