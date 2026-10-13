import { describe, expect, it } from "vitest";
import { packageName } from "./index";

describe("@cb/db", () => {
  it("is wired into Vitest", () => {
    expect(packageName).toBe("@cb/db");
  });
});
