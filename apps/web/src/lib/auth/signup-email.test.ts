import { describe, expect, it } from "vitest";
import { renderSignupEmail } from "./signup-email";

const VERIFY_URL = "https://app.example.test/verify/abcDEF123_-xyz789abcDEF123_-xyz789abcDEF12";

describe("sign-up emails", () => {
  it("the confirm link email: plain English text with the link and how long it works", () => {
    const message = renderSignupEmail({
      kind: "verify",
      to: "owner@cable.test",
      language: "en",
      verifyUrl: VERIFY_URL,
      expiresInHours: 24,
    });
    expect(message.to).toBe("owner@cable.test");
    expect(message.subject).toBe("Confirm your email for Cable Billing");
    expect(message.text).toContain(VERIFY_URL);
    expect(message.text).toContain("24 hours");
    expect(message.text).toContain("30 free days");
    expect(message.text).not.toMatch(/[{}]/);
  });

  it("is in Hindi when the form was in Hindi", () => {
    const message = renderSignupEmail({
      kind: "verify",
      to: "owner@cable.test",
      language: "hi",
      verifyUrl: VERIFY_URL,
      expiresInHours: 24,
    });
    expect(message.subject).toBe("केबल बिलिंग के लिए अपना ईमेल पक्का करें");
    expect(message.text).toContain("24 घंटे");
    expect(message.text).toContain(VERIFY_URL);
    expect(message.text).not.toMatch(/[{}]/);
  });

  it("'you already have an account' points to sign-in and reset, with no sign-up link", () => {
    for (const language of ["en", "hi"] as const) {
      const message = renderSignupEmail({
        kind: "already_registered",
        to: "owner@cable.test",
        language,
        signInUrl: "https://app.example.test/login",
        resetUrl: "https://app.example.test/reset",
      });
      expect(message.text).toContain("https://app.example.test/login");
      expect(message.text).toContain("https://app.example.test/reset");
      expect(message.text).not.toContain("/verify/");
      expect(message.text).not.toMatch(/[{}]/);
    }
  });
});
