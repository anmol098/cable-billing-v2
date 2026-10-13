import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/test/intl";
import { formStateFor } from "./_components/form-state";
import { LoginForm } from "./login-form";

describe("LoginForm", () => {
  it("has a big labelled login field, a password field with Show/Hide, and one Sign in button", () => {
    renderWithIntl(<LoginForm action={vi.fn(async () => ({}))} next="/customers" />);
    const login = screen.getByLabelText("Mobile no., user name or email");
    expect(login).toHaveAttribute("autocomplete", "username");
    const password = screen.getByLabelText("Password");
    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveAttribute("autocomplete", "current-password");

    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(toggle).toHaveTextContent("Show");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(password).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    expect(screen.getAllByRole("button", { name: "Sign in" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Forgot password?" })).toHaveAttribute(
      "href",
      "/reset",
    );
    expect(document.querySelector('input[name="next"]')).toHaveValue("/customers");
  });

  it("is in Hindi when the locale is Hindi", () => {
    renderWithIntl(<LoginForm action={vi.fn(async () => ({}))} />, "hi");
    expect(screen.getByLabelText("मोबाइल नंबर, यूज़र नेम या ईमेल")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "लॉग इन करें" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "पासवर्ड दिखाएँ" })).toBeInTheDocument();
  });

  it("maps every auth failure to a message key, with minutes for rate limits", () => {
    expect(formStateFor({ code: "INVALID_CREDENTIALS" }, { login: "ramesh" })).toEqual({
      login: "ramesh",
      error: "invalid_credentials",
    });
    expect(formStateFor({ code: "RATE_LIMITED", retryAfterSeconds: 61 })).toEqual({
      error: "rate_limited",
      minutes: 2,
    });
    expect(formStateFor({ code: "RATE_LIMITED" })).toEqual({ error: "rate_limited", minutes: 1 });
    expect(formStateFor({ code: "ROLE_NOT_ALLOWED" }).error).toBe("role_not_allowed");
    expect(formStateFor({ code: "ACCOUNT_DISABLED" }).error).toBe("account_disabled");
    expect(formStateFor({ code: "UNAUTHENTICATED" }).error).toBe("two_factor_expired");
  });
});
