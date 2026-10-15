/**
 * The platform admin's setup link page (T-086d): the token comes from the URL fragment, leaves the
 * address bar at once and travels only in Server Action bodies; two steps; errors in words
 * (wrong code, key changed elsewhere, dead link); English and Hindi.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formStateFor } from "@/app/(auth)/login/_components/form-state";
import { renderWithIntl } from "@/test/intl";
import type { AdminSetupState } from "./actions";
import { AdminSetupFlow } from "./setup-flow";

const TOKEN = "A".repeat(43);
const KEY = "JBSWY3DPEHPK3PXP";
const KEY_ID = "0123456789abcdef";

const formOf = (fn: { mock: { calls: unknown[][] } }, call = 0) =>
  fn.mock.calls[call]?.[1] as FormData;

function open(
  props: Partial<Parameters<typeof AdminSetupFlow>[0]> = {},
  { hash = `#${TOKEN}`, locale = "en" as "en" | "hi" } = {},
) {
  window.history.replaceState(null, "", `/admin-setup${hash}`);
  const check = vi.fn(async () => ({ email: "asha@platform.test" }));
  const all = {
    check,
    start: vi.fn(async (): Promise<AdminSetupState> => ({})),
    finish: vi.fn(async (): Promise<AdminSetupState> => ({})),
    passwordMinLength: 8,
    passwordMaxLength: 128,
    ...props,
  };
  renderWithIntl(<AdminSetupFlow {...all} />, locale);
  return all;
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("AdminSetupFlow", () => {
  it("reads the token from the #fragment, removes it from the address bar, and sends it only in action bodies", async () => {
    const start = vi.fn(
      async (): Promise<AdminSetupState> => ({
        secret: KEY,
        totpUri: `otpauth://totp/x?secret=${KEY}`,
        keyId: KEY_ID,
      }),
    );
    const finish = vi.fn(
      async (): Promise<AdminSetupState> => ({ keyId: KEY_ID, error: "invalid_code" }),
    );
    const { check } = open({ start, finish });
    expect(await screen.findByTestId("admin-setup-account")).toHaveTextContent(
      "asha@platform.test",
    );
    expect(check).toHaveBeenCalledWith(TOKEN);
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);

    // Step 1 has no password or code fields: only Start.
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(formOf(start).get("token")).toBe(TOKEN);

    expect(await screen.findByTestId("totp-secret")).toHaveTextContent(KEY);
    expect(screen.getByRole("link", { name: "Open in authenticator app" })).toHaveAttribute(
      "href",
      `otpauth://totp/x?secret=${KEY}`,
    );
    const password = screen.getByLabelText("New password");
    expect(password).toHaveAttribute("autocomplete", "new-password");
    expect(password).toHaveAttribute("minlength", "8");
    expect(password).toHaveAttribute("maxlength", "128");
    expect(screen.getByLabelText("New password again")).toHaveAttribute("type", "password");
    fireEvent.change(screen.getByLabelText("6-digit code from the app"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Turn on and sign in" }));
    await waitFor(() => expect(finish).toHaveBeenCalledTimes(1));
    expect(formOf(finish).get("token")).toBe(TOKEN);
    expect(formOf(finish).get("keyId")).toBe(KEY_ID);
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong code.");
    // The key stays on screen after a wrong code.
    expect(screen.getByTestId("totp-secret")).toHaveTextContent(KEY);
  });

  it("the key was replaced elsewhere: says so and asks for Start again, then shows the new key", async () => {
    let key = 0;
    const start = vi.fn(async (): Promise<AdminSetupState> => {
      key += 1;
      return { secret: `${KEY}${key}`, keyId: `${KEY_ID.slice(0, 15)}${key}` };
    });
    const finish = vi.fn(
      async (_s: AdminSetupState, form: FormData): Promise<AdminSetupState> => ({
        keyId: String(form.get("keyId")),
        ...formStateFor({ code: "SETUP_KEY_CHANGED" }),
      }),
    );
    open({ start, finish });
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    expect(await screen.findByTestId("totp-secret")).toHaveTextContent(`${KEY}1`);
    fireEvent.click(screen.getByRole("button", { name: "Turn on and sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The key changed. Press Start again.",
    );
    expect(screen.queryByTestId("totp-secret")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByTestId("totp-secret")).toHaveTextContent(`${KEY}2`);
    // The old answer no longer shows.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a used, expired or missing link: one sentence, no form", async () => {
    open({ check: vi.fn(async () => null) });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This setup link does not work any more. Ask for a new setup link.",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("no #token at all: the same sentence, and nothing is asked of the server", async () => {
    const check = vi.fn(async () => ({ email: "x@y.test" }));
    open({ check }, { hash: "" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This setup link does not work any more.",
    );
    expect(check).not.toHaveBeenCalled();
  });

  it("a link that dies between Start and Done", async () => {
    const start = vi.fn(
      async (): Promise<AdminSetupState> => formStateFor({ code: "INVALID_TOKEN" }),
    );
    open({ start });
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This setup link does not work any more.",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("reads in Hindi", async () => {
    open({}, { locale: "hi" });
    expect(await screen.findByRole("button", { name: "शुरू करें" })).toBeInTheDocument();
    expect(screen.getByText("अकाउंट")).toBeInTheDocument();
  });

  it("an admin without the link is told to ask for one (sign-in error words)", () => {
    expect(formStateFor({ code: "SETUP_LINK_REQUIRED" })).toEqual({ error: "setup_link_required" });
    expect(formStateFor({ code: "SETUP_KEY_CHANGED" })).toEqual({ error: "setup_key_changed" });
  });
});
