import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/test/intl";
import type { VerifyFormState } from "./actions";
import { VerifyForm } from "./verify-form";

const TOKEN = "abcDEF123_-xyz789abcDEF123_-xyz789abcDEF12";

const render = (action: (s: VerifyFormState, f: FormData) => Promise<VerifyFormState>) =>
  renderWithIntl(
    <VerifyForm
      action={action}
      token={TOKEN}
      businessName="Anmol Cable Network"
      email="owner@cable.test"
    />,
  );

describe("VerifyForm", () => {
  it("shows what is being confirmed, asks for the password, one Start button", () => {
    render(vi.fn(async () => ({})));
    expect(screen.getByText("Anmol Cable Network")).toBeInTheDocument();
    expect(screen.getByText("owner@cable.test")).toBeInTheDocument();
    expect(screen.getByLabelText("Password (the one you chose)")).toHaveAttribute(
      "type",
      "password",
    );
    expect(document.querySelector('input[name="token"]')).toHaveValue(TOKEN);
    expect(screen.getAllByRole("button", { name: "Start" })).toHaveLength(1);
  });

  it("says a wrong password plainly and marks the field", async () => {
    render(vi.fn(async () => ({ error: "wrong_password" as const })));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(
      await screen.findByText(
        "Wrong password. Type the password you chose when you created the account.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Password (the one you chose)")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("an existing account or a used link offers Sign in", async () => {
    render(vi.fn(async () => ({ error: "account_exists" as const })));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(
      await screen.findByText("This email already has an account. Sign in."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
  });

  it("is in Hindi when the locale is Hindi", () => {
    renderWithIntl(
      <VerifyForm
        action={vi.fn(async () => ({}))}
        token={TOKEN}
        businessName="अनमोल केबल"
        email="owner@cable.test"
      />,
      "hi",
    );
    expect(screen.getByRole("button", { name: "शुरू करें" })).toBeInTheDocument();
    expect(screen.getByLabelText("पासवर्ड (जो आपने बनाया था)")).toBeInTheDocument();
  });
});
