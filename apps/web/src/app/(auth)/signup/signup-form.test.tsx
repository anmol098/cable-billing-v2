import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/test/intl";
import { type SignupFormState, signupFormStateFor } from "./form-state";
import { SignupForm } from "./signup-form";

const VALUES = {
  business_name: "Anmol Cable",
  owner_name: "Anmol",
  mobile: "98765",
  email: "owner@cable.test",
};

describe("SignupForm", () => {
  it("has the five labelled fields, Show/Hide on the password, one big button, and a sign-in link", () => {
    renderWithIntl(<SignupForm action={vi.fn(async () => ({}))} />);
    expect(screen.getByLabelText("Business name")).toHaveAttribute("autocomplete", "organization");
    expect(screen.getByLabelText("Your name")).toHaveAttribute("autocomplete", "name");
    const mobile = screen.getByLabelText("Mobile no.");
    expect(mobile).toHaveAttribute("type", "tel");
    expect(mobile).toHaveAttribute("inputmode", "tel");
    expect(mobile).toHaveAccessibleDescription("You can sign in with this number too.");
    expect(screen.getByLabelText("Email")).toHaveAttribute("type", "email");
    const password = screen.getByLabelText("Password");
    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveAttribute("autocomplete", "new-password");
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(password).toHaveAttribute("type", "text");
    expect(screen.getAllByRole("button", { name: "Start 30 days free" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    // No Turnstile site key configured → no person check box (local, CI).
    expect(screen.queryByRole("region", { name: "Check that you are a person" })).toBeNull();
  });

  it("shows the person check box when a site key is configured", () => {
    renderWithIntl(
      <SignupForm action={vi.fn(async () => ({}))} siteKey="1x00000000000000000000AA" />,
    );
    expect(screen.getByRole("region", { name: "Check that you are a person" })).toBeInTheDocument();
  });

  it("is in Hindi when the locale is Hindi", () => {
    renderWithIntl(<SignupForm action={vi.fn(async () => ({}))} />, "hi");
    expect(screen.getByLabelText("बिज़नेस का नाम")).toBeInTheDocument();
    expect(screen.getByLabelText("मोबाइल नंबर")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "30 दिन मुफ़्त शुरू करें" })).toBeInTheDocument();
  });

  it("marks the wrong fields in words, keeps what was typed (never the password)", async () => {
    const answer: SignupFormState = signupFormStateFor(
      { code: "VALIDATION", fields: { mobile: "invalid", password: "too_short" } },
      VALUES,
      1,
    );
    const action = vi.fn(async () => answer);
    renderWithIntl(<SignupForm action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Start 30 days free" }));
    expect(await screen.findByText("Fix the boxes marked in red.")).toBeInTheDocument();
    const mobile = screen.getByLabelText("Mobile no.");
    expect(mobile).toHaveAttribute("aria-invalid", "true");
    expect(mobile).toHaveAccessibleDescription("Type a 10-digit mobile number.");
    expect(mobile).toHaveValue("98765");
    expect(screen.getByLabelText("Password")).toHaveAccessibleDescription(
      "Use at least 8 letters, numbers or signs.",
    );
    expect(screen.getByLabelText("Business name")).toHaveValue("Anmol Cable");
    expect(screen.getByLabelText("Business name")).not.toHaveAttribute("aria-invalid");
  });

  it("after sending: 'check your email' with the address, and nothing else to do", async () => {
    const action = vi.fn(async () => ({ sent: true, values: VALUES, attempt: 1 }));
    renderWithIntl(<SignupForm action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Start 30 days free" }));
    expect(await screen.findByText(/We sent a link to owner@cable.test/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.getByRole("link", { name: "Use a different email" })).toHaveAttribute(
      "href",
      "/signup",
    );
  });

  it("maps every failure to a message key, with minutes for rate limits", () => {
    expect(signupFormStateFor({ code: "RATE_LIMITED", retryAfterSeconds: 61 }, VALUES, 2)).toEqual({
      error: "rate_limited",
      minutes: 2,
      values: VALUES,
      attempt: 2,
    });
    expect(signupFormStateFor({ code: "BOT_CHECK_FAILED" }, VALUES, 1).error).toBe(
      "person_check_failed",
    );
    expect(signupFormStateFor({ code: "EMAIL_FAILED" }, VALUES, 1).error).toBe("email_failed");
    expect(signupFormStateFor({ code: "INVALID_LINK" }, VALUES, 1).error).toBe("unexpected");
    expect(
      signupFormStateFor(
        {
          code: "VALIDATION",
          fields: {
            business_name: "required",
            owner_name: "too_long",
            email: "invalid",
            password: "too_long",
          },
        },
        VALUES,
        1,
      ).fields,
    ).toEqual({
      business_name: "required",
      owner_name: "too_long",
      email: "email_invalid",
      password: "password_too_long",
    });
  });
});
