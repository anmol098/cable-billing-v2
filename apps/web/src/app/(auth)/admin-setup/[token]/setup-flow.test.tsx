/** The platform admin's setup link form (T-086d): two steps, errors in words, English and Hindi. */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { formStateFor } from "@/app/(auth)/login/_components/form-state";
import { renderWithIntl } from "@/test/intl";
import type { AdminSetupState } from "../actions";
import { AdminSetupFlow } from "./setup-flow";

const TOKEN = "A".repeat(43);
const KEY = "JBSWY3DPEHPK3PXP";

describe("AdminSetupFlow", () => {
  it("Start shows the key; then password twice and the code, with the token sent each time", async () => {
    const start = vi.fn(
      async (): Promise<AdminSetupState> => ({
        secret: KEY,
        totpUri: `otpauth://totp/x?secret=${KEY}`,
      }),
    );
    const finish = vi.fn(async (): Promise<AdminSetupState> => ({ error: "invalid_code" }));
    renderWithIntl(
      <AdminSetupFlow token={TOKEN} email="asha@platform.test" start={start} finish={finish} />,
    );
    expect(screen.getByTestId("admin-setup-account")).toHaveTextContent("asha@platform.test");
    // Step 1 has no password or code fields: only Start.
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect((start.mock.calls[0] as unknown as [unknown, FormData])[1].get("token")).toBe(TOKEN);

    expect(await screen.findByTestId("totp-secret")).toHaveTextContent(KEY);
    expect(screen.getByRole("link", { name: "Open in authenticator app" })).toHaveAttribute(
      "href",
      `otpauth://totp/x?secret=${KEY}`,
    );
    expect(screen.getByLabelText("New password")).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByLabelText("New password again")).toHaveAttribute("type", "password");
    fireEvent.change(screen.getByLabelText("6-digit code from the app"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Turn on and sign in" }));
    await waitFor(() => expect(finish).toHaveBeenCalledTimes(1));
    expect((finish.mock.calls[0] as unknown as [unknown, FormData])[1].get("token")).toBe(TOKEN);
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong code.");
    // The key stays on screen after a wrong code.
    expect(screen.getByTestId("totp-secret")).toHaveTextContent(KEY);
  });

  it("a used or expired link: one sentence, no form", async () => {
    const start = vi.fn(
      async (): Promise<AdminSetupState> => formStateFor({ code: "INVALID_TOKEN" }),
    );
    renderWithIntl(
      <AdminSetupFlow token={TOKEN} email="asha@platform.test" start={start} finish={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This setup link does not work any more. Ask for a new setup link.",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("reads in Hindi", () => {
    renderWithIntl(
      <AdminSetupFlow token={TOKEN} email="a@b.test" start={vi.fn()} finish={vi.fn()} />,
      "hi",
    );
    expect(screen.getByRole("button", { name: "शुरू करें" })).toBeInTheDocument();
    expect(screen.getByText("अकाउंट")).toBeInTheDocument();
  });

  it("an admin without the link is told to ask for one (sign-in error words)", () => {
    expect(formStateFor({ code: "SETUP_LINK_REQUIRED" })).toEqual({ error: "setup_link_required" });
  });
});
