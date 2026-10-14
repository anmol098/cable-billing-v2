/** Pure team rules (T-032): password rules per role, sign-in names, form field checks. */
import { describe, expect, it } from "vitest";
import { checkLinemanFields, checkStaffFields, loginBaseFromEmail } from "./fields";
import {
  LINEMAN_PASSWORD_MIN_LENGTH,
  linemanPasswordProblem,
  loginProblem,
  normalizeLogin,
  PASSWORD_MAX_LENGTH,
  staffPasswordProblem,
  suggestedLoginCandidates,
  suggestLinemanPassword,
} from "./rules";

describe("lineman password rules", () => {
  it.each([
    ["583920", null],
    ["river 2468", null],
    ["ravi1990", null],
    ["12345", "too_short"],
    ["123456", "too_simple"],
    ["987654", "too_simple"],
    ["3456789", "too_simple"],
    ["111111", "too_simple"],
    ["121212", "too_simple"],
    ["aaaaaa", "too_simple"],
    ["abcdef", "too_simple"],
    ["FEDCBA", "too_simple"],
    ["Password", "too_simple"],
    ["qwerty", "too_simple"],
  ])("%s → %s", (password, expected) => {
    expect(linemanPasswordProblem(password)).toBe(expected);
  });

  it("refuses the sign-in name and the mobile number, and very long passwords", () => {
    expect(linemanPasswordProblem("9876501234", { mobile: "9876501234" })).toBe("same_as_login");
    expect(linemanPasswordProblem("RAVI.K", { login: "ravi.k" })).toBe("same_as_login");
    expect(linemanPasswordProblem("x".repeat(PASSWORD_MAX_LENGTH + 1))).toBe("too_long");
    expect(LINEMAN_PASSWORD_MIN_LENGTH).toBe(6);
  });

  it("staff need the web's 8 characters", () => {
    expect(staffPasswordProblem("583920")).toBe("too_short");
    expect(staffPasswordProblem("counter desk 77")).toBeNull();
    expect(staffPasswordProblem("12345678")).toBe("too_simple");
  });

  it("suggests a random 6-digit password that passes the rules", () => {
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 50; i += 1) {
      const password = suggestLinemanPassword(random, { mobile: "9876501234" });
      expect(password).toMatch(/^\d{6}$/);
      expect(linemanPasswordProblem(password)).toBeNull();
    }
    expect(() => suggestLinemanPassword(() => 1)).toThrow();
  });
});

describe("sign-in names", () => {
  it("normalises and checks", () => {
    expect(normalizeLogin("  Ravi.K ")).toBe("ravi.k");
    expect(loginProblem("ra")).toBe("too_short");
    expect(loginProblem("ravi k")).toBe("bad_characters");
    expect(loginProblem("ravi@cable")).toBe("bad_characters");
    expect(loginProblem("x".repeat(101))).toBe("too_long");
    expect(loginProblem("9876501234-2")).toBeNull();
  });

  it("suggests the mobile, then -2 … -10", () => {
    const candidates = suggestedLoginCandidates("9876501234");
    expect(candidates).toHaveLength(10);
    expect(candidates.slice(0, 3)).toEqual(["9876501234", "9876501234-2", "9876501234-3"]);
    expect(candidates.at(-1)).toBe("9876501234-10");
  });

  it("derives a base from an email", () => {
    expect(loginBaseFromEmail("Meena.K+desk@cable.in")).toBe("meena.kdesk");
    expect(loginBaseFromEmail("a@cable.in")).toBeNull();
  });
});

describe("form fields", () => {
  it("lineman: mobile in any common form, login defaults to it", () => {
    const result = checkLinemanFields({
      name: " Ravi  Kumar ",
      mobile: "+91 98765-01234",
      password: "583920",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        name: "Ravi Kumar",
        mobile: "9876501234",
        loginCandidates: suggestedLoginCandidates("9876501234"),
        loginSuggested: true,
        password: "583920",
      },
    });
    const typed = checkLinemanFields({
      name: "Ravi",
      mobile: "9876501234",
      login: " Ravi.K ",
      password: "583920",
    });
    expect(typed).toMatchObject({ ok: true, value: { loginCandidates: ["ravi.k"] } });
  });

  it("lineman: every problem at once, no 'user name needed' when the mobile is the problem", () => {
    expect(checkLinemanFields({ name: "", mobile: "", password: "" })).toEqual({
      ok: false,
      fields: [
        { path: "name", code: "required" },
        { path: "mobile", code: "required" },
        { path: "password", code: "required" },
      ],
    });
    expect(
      checkLinemanFields({ name: "x".repeat(121), mobile: "12345", password: "999999" }),
    ).toEqual({
      ok: false,
      fields: [
        { path: "name", code: "too_long" },
        { path: "mobile", code: "invalid" },
        { path: "password", code: "too_simple" },
      ],
    });
  });

  it("staff: invite needs an email; the login comes from the mobile, else the email", () => {
    expect(checkStaffFields({ name: "Asha", setup: "invite" })).toEqual({
      ok: false,
      fields: [{ path: "email", code: "required" }],
    });
    expect(
      checkStaffFields({ name: "Asha", email: "Asha.R@Cable.in", setup: "invite" }),
    ).toMatchObject({
      ok: true,
      value: {
        email: "asha.r@cable.in",
        password: null,
        loginCandidates: expect.arrayContaining(["asha.r", "asha.r-2"]),
      },
    });
    expect(
      checkStaffFields({
        name: "Asha",
        mobile: "9876501234",
        email: "asha@cable.in",
        setup: "password",
        password: "counter desk 77",
      }),
    ).toMatchObject({
      ok: true,
      value: { loginCandidates: expect.arrayContaining(["9876501234", "9876501234-2"]) },
    });
    expect(checkStaffFields({ name: "Asha", setup: "password", password: "x" })).toEqual({
      ok: false,
      fields: [
        { path: "login", code: "required" },
        { path: "password", code: "too_short" },
      ],
    });
    expect(
      checkStaffFields({ name: "Asha", email: "not-an-email", setup: "password", password: "" }),
    ).toEqual({
      ok: false,
      fields: [
        { path: "email", code: "invalid" },
        { path: "password", code: "required" },
      ],
    });
  });
});
