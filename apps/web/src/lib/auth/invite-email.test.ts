import { describe, expect, it } from "vitest";
import { renderInviteEmail } from "./invite-email";

const URL_ = "https://app.example.test/reset/abcDEF123_-xyz789";
const invite = { businessName: "Anmol Cable Network", login: "meena" };

describe("staff invitation email (T-032)", () => {
  it("names the business and the user name, carries the link and how long it works", () => {
    const message = renderInviteEmail({
      to: "meena@cable.test",
      language: "en",
      resetUrl: URL_,
      expiresInMinutes: 60,
      invite,
    });
    expect(message.to).toBe("meena@cable.test");
    expect(message.subject).toBe("Anmol Cable Network added you to Cable Billing");
    expect(message.text).toContain("Your user name is meena.");
    expect(message.text).toContain(URL_);
    expect(message.text).toContain("60 minutes");
    expect(message.text).toContain("Forgot password?");
    expect(message.text).not.toMatch(/[{}]/);
  });

  it("is in Hindi for Hindi users", () => {
    const message = renderInviteEmail({
      to: "meena@cable.test",
      language: "hi",
      resetUrl: URL_,
      expiresInMinutes: 60,
      invite,
    });
    expect(message.subject).toBe("Anmol Cable Network ने आपको केबल बिलिंग में जोड़ा");
    expect(message.text).toContain("60 मिनट");
    expect(message.text).toContain(URL_);
  });
});
