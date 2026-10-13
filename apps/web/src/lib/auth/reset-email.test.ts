import { describe, expect, it } from "vitest";
import { renderResetEmail } from "./reset-email";

const URL_ = "https://app.example.test/reset/abcDEF123_-xyz789";

describe("password reset email", () => {
  it("is plain text in English with the link and how long it works", () => {
    const message = renderResetEmail({
      to: "owner@cable.test",
      language: "en",
      resetUrl: URL_,
      expiresInMinutes: 60,
    });
    expect(message.to).toBe("owner@cable.test");
    expect(message.subject).toBe("Set a new password for Cable Billing");
    expect(message.text).toContain(URL_);
    expect(message.text).toContain("60 minutes");
    expect(message.text).toContain("If it was not you");
    expect(message.text).not.toMatch(/[{}]/);
  });

  it("is in Hindi for Hindi users", () => {
    const message = renderResetEmail({
      to: "staff@cable.test",
      language: "hi",
      resetUrl: URL_,
      expiresInMinutes: 60,
    });
    expect(message.subject).toBe("केबल बिलिंग का नया पासवर्ड बनाएँ");
    expect(message.text).toContain("60 मिनट");
    expect(message.text).toContain(URL_);
    expect(message.text).toContain("केबल बिलिंग");
  });
});
