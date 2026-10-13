/**
 * The Staff and linemen page (T-032) with fake Server Actions: the list (status, phones, share
 * link without the password), add lineman (user name follows the mobile, password shown, "Make
 * one for me", errors in words, the "added" screen), add staff by invite, new password, switch
 * off (plain-words confirm), sign out a phone, read-only mode, Hindi. Plus the pure helpers.
 */
import { ToastProvider } from "@cb/ui";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/test/intl";
import en from "../../../../../messages/en.json";
import { type AddResult, type DoneResult, teamFailure } from "./action-state";
import type { MemberRow } from "./rows";
import { groupMobile } from "./rows";
import { LINEMAN_APP_URL, shareMessage, whatsAppShareUrl } from "./share";
import { type TeamActions, TeamManager } from "./team-manager";

// Radix RadioGroup measures its items with ResizeObserver, which jsdom does not implement.
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const SHARE = whatsAppShareUrl(
  "9876501234",
  "Test Cable: sign-in for the Cable Billing lineman app.\nUser name: 9876501234",
);

const RAVI: MemberRow = {
  id: "0199a0b0-0000-7000-8000-000000000001",
  role: "lineman",
  name: "Ravi Kumar",
  login: "9876501234",
  mobile: "98765 01234",
  email: null,
  active: true,
  passwordSet: true,
  shareUrl: SHARE,
  phones: [
    {
      id: "0199a0b0-0000-7000-8000-0000000000d1",
      label: "Xiaomi Redmi 9A (ABC)",
      appVersion: "App 1.0.3",
      lastOnline: "Phone last online 4:05 PM",
      signedIn: true,
      signedOut: false,
    },
  ],
};
const SURESH: MemberRow = {
  ...RAVI,
  id: "0199a0b0-0000-7000-8000-000000000002",
  name: "Suresh Pal",
  login: "9876501235",
  active: false,
  phones: [],
};
const MEENA: MemberRow = {
  id: "0199a0b0-0000-7000-8000-000000000003",
  role: "staff",
  name: "Meena",
  login: "meena",
  mobile: null,
  email: "meena@cable.test",
  active: true,
  passwordSet: false,
  shareUrl: null,
  phones: [],
};

const ok: DoneResult = { ok: true };

function fakeActions(overrides: Partial<TeamActions> = {}): TeamActions {
  return {
    addLineman: vi.fn(async () => ({ ok: false, error: "unexpected" }) as AddResult),
    addStaff: vi.fn(async () => ({ ok: false, error: "unexpected" }) as AddResult),
    resetPassword: vi.fn(async () => ok),
    switchOff: vi.fn(async () => ok),
    switchOn: vi.fn(async () => ok),
    signOutPhone: vi.fn(async () => ok),
    ...overrides,
  };
}

function renderPage(
  options: {
    actions?: TeamActions;
    editable?: boolean;
    readOnly?: boolean;
    locale?: "en" | "hi";
    linemen?: MemberRow[];
    staff?: MemberRow[];
  } = {},
) {
  const actions = options.actions ?? fakeActions();
  renderWithIntl(
    <ToastProvider closeLabel="Close" label="Notifications">
      <TeamManager
        title="Staff and linemen"
        linemen={options.linemen ?? [RAVI, SURESH]}
        staff={options.staff ?? [MEENA]}
        editable={options.editable ?? true}
        readOnly={options.readOnly ?? false}
        rules={{ linemanMin: 6, staffMin: 8 }}
        suggestedPassword="583920"
        actions={actions}
      />
    </ToastProvider>,
    options.locale,
  );
  return actions;
}

const card = (name: string) => {
  const item = document.querySelector(`[data-member="${name}"]`);
  if (!(item instanceof HTMLElement)) throw new Error(`no card for ${name}`);
  return within(item);
};

describe("the team list", () => {
  it("shows linemen with their phones and staff, each with status words and icons", () => {
    renderPage();
    const ravi = card("Ravi Kumar");
    expect(ravi.getByText("Active")).toBeInTheDocument();
    expect(ravi.getByText("User name: 9876501234")).toBeInTheDocument();
    expect(ravi.getByText("Mobile no.: 98765 01234")).toBeInTheDocument();
    expect(ravi.getByText("Xiaomi Redmi 9A (ABC)")).toBeInTheDocument();
    expect(ravi.getByText("App 1.0.3 · Phone last online 4:05 PM")).toBeInTheDocument();
    expect(ravi.getByText("Signed in")).toBeInTheDocument();
    expect(ravi.getByRole("button", { name: "Sign out this phone" })).toBeInTheDocument();
    expect(ravi.getByRole("button", { name: "Switch off Ravi Kumar" })).toBeInTheDocument();

    const suresh = card("Suresh Pal");
    expect(suresh.getByText("Switched off")).toBeInTheDocument();
    expect(suresh.getByText("Not signed in on any phone yet.")).toBeInTheDocument();
    expect(suresh.getByRole("button", { name: "Switch on Suresh Pal" })).toBeInTheDocument();
    // No share link for a switched-off lineman.
    expect(suresh.queryByRole("link")).toBeNull();

    const meena = card("Meena");
    expect(meena.getByText("Has not set a password yet")).toBeInTheDocument();
    expect(meena.getByText("Email: meena@cable.test")).toBeInTheDocument();
    expect(meena.queryByText("Phones")).toBeNull();
    // One primary action on the page.
    expect(screen.getByRole("button", { name: "Add lineman" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add staff" })).toBeInTheDocument();
  });

  it("shares the sign-in on WhatsApp (link without the password) and says only 'WhatsApp opened'", async () => {
    renderPage();
    const link = card("Ravi Kumar").getByRole("link", {
      name: "Share Ravi Kumar's sign-in on WhatsApp",
    });
    expect(link).toHaveAttribute("href", SHARE);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("href")).not.toContain("583920");
    fireEvent.click(link);
    expect(await screen.findByText("WhatsApp opened")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bsent\b/i);
  });

  it("read-only: the list without buttons, and the reason in words", () => {
    renderPage({ editable: false, readOnly: true });
    expect(screen.getByText(en.team.read_only)).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("link")).toBeNull();
    expect(card("Ravi Kumar").getByText("Xiaomi Redmi 9A (ABC)")).toBeInTheDocument();
  });

  it("empty lists say what to do", () => {
    renderPage({ linemen: [], staff: [] });
    expect(screen.getByText("No linemen yet. Add your first lineman.")).toBeInTheDocument();
    expect(screen.getByText("No staff yet.")).toBeInTheDocument();
  });

  it("works in Hindi", () => {
    renderPage({ locale: "hi" });
    expect(screen.getByRole("button", { name: "लाइनमैन जोड़ें" })).toBeInTheDocument();
    expect(card("Suresh Pal").getByText("बंद")).toBeInTheDocument();
    expect(card("Ravi Kumar").getByText("लॉग इन है")).toBeInTheDocument();
  });
});

describe("add lineman", () => {
  it("the user name follows the mobile, the password is shown, and the added screen has the share link", async () => {
    const addLineman = vi.fn(
      async (): Promise<AddResult> => ({
        ok: true,
        added: {
          role: "lineman",
          name: "Ramesh",
          login: "9811122233",
          suggestedLogin: null,
          shareUrl: SHARE,
          invite: null,
        },
      }),
    );
    renderPage({ actions: fakeActions({ addLineman }) });
    fireEvent.click(screen.getByRole("button", { name: "Add lineman" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Ramesh" } });
    fireEvent.change(dialog.getByLabelText("Mobile no."), { target: { value: "+91 98111 22233" } });
    expect(dialog.getByLabelText("User name")).toHaveValue("9811122233");
    const password = dialog.getByLabelText("Password");
    expect(password).toHaveAttribute("type", "text"); // shown by default for linemen (D-07)
    fireEvent.click(dialog.getByRole("button", { name: "Make one for me" }));
    expect(password).toHaveValue("583920");
    await act(async () => {
      fireEvent.click(dialog.getByRole("button", { name: "Add lineman" }));
    });
    expect(addLineman).toHaveBeenCalledWith({
      name: "Ramesh",
      mobile: "+91 98111 22233",
      login: "9811122233",
      password: "583920",
      language: "hi",
    });
    const added = within(await screen.findByTestId("team-added"));
    expect(added.getByText("Ramesh is added")).toBeInTheDocument();
    expect(added.getByTestId("added-login")).toHaveTextContent("9811122233");
    expect(added.getByText("583920")).toBeInTheDocument();
    expect(
      added.getByText("Tell Ramesh the password yourself. It is not in the WhatsApp message."),
    ).toBeInTheDocument();
    expect(added.getByRole("link", { name: "Share Ramesh's sign-in on WhatsApp" })).toHaveAttribute(
      "href",
      SHARE,
    );
  });

  it("shows each problem next to its field, in words", async () => {
    const addLineman = vi.fn(async () =>
      teamFailure({
        code: "VALIDATION",
        details: {
          fields: [
            { path: "name", code: "required" },
            { path: "password", code: "too_short" },
          ],
        },
      }),
    );
    renderPage({ actions: fakeActions({ addLineman }) });
    fireEvent.click(screen.getByRole("button", { name: "Add lineman" }));
    const dialog = within(await screen.findByRole("dialog"));
    await act(async () => {
      fireEvent.click(dialog.getByRole("button", { name: "Add lineman" }));
    });
    expect(await dialog.findByText("Write the name.")).toBeInTheDocument();
    expect(dialog.getByText("Use at least 6 letters or numbers.")).toBeInTheDocument();
    expect(dialog.getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
  });

  it("says when the suggested user name was taken", async () => {
    const addLineman = vi.fn(
      async (): Promise<AddResult> => ({
        ok: true,
        added: {
          role: "lineman",
          name: "Ramesh",
          login: "9811122233-2",
          suggestedLogin: "9811122233",
          shareUrl: SHARE,
          invite: null,
        },
      }),
    );
    renderPage({ actions: fakeActions({ addLineman }) });
    fireEvent.click(screen.getByRole("button", { name: "Add lineman" }));
    const dialog = within(await screen.findByRole("dialog"));
    await act(async () => {
      fireEvent.click(dialog.getByRole("button", { name: "Add lineman" }));
    });
    expect(
      await screen.findByText("9811122233 was already used, so the user name is 9811122233-2."),
    ).toBeInTheDocument();
  });
});

describe("add staff", () => {
  it("by invite: no password field, and the email notice", async () => {
    const addStaff = vi.fn(
      async (): Promise<AddResult> => ({
        ok: true,
        added: {
          role: "staff",
          name: "Asha",
          login: "asha",
          suggestedLogin: null,
          shareUrl: null,
          invite: { email: "asha@cable.test", queued: true, minutes: 60 },
        },
      }),
    );
    renderPage({ actions: fakeActions({ addStaff }) });
    fireEvent.click(screen.getByRole("button", { name: "Add staff" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Asha" } });
    fireEvent.change(dialog.getByLabelText("Email (if they have one)"), {
      target: { value: "asha@cable.test" },
    });
    fireEvent.click(dialog.getByRole("radio", { name: /Email them a link/ }));
    expect(dialog.queryByLabelText("Password")).toBeNull();
    await act(async () => {
      fireEvent.click(dialog.getByRole("button", { name: "Add staff" }));
    });
    expect(addStaff).toHaveBeenCalledWith(
      expect.objectContaining({ setup: "invite", password: "", email: "asha@cable.test" }),
    );
    expect(
      await screen.findByText(
        /We are emailing a link to asha@cable.test. It works for 60 minutes./,
      ),
    ).toBeInTheDocument();
  });
});

describe("row actions", () => {
  it("new password: the note says the phone will be signed out", async () => {
    const resetPassword = vi.fn(async () => ok);
    renderPage({ actions: fakeActions({ resetPassword }) });
    fireEvent.click(screen.getByRole("button", { name: "New password for Ravi Kumar" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(
      dialog.getByText(
        "Ravi Kumar's phone will be signed out. Ravi Kumar signs in again with the new password.",
      ),
    ).toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText("Password"), { target: { value: "mango 1357" } });
    await act(async () => {
      fireEvent.click(dialog.getByRole("button", { name: "Save new password" }));
    });
    expect(resetPassword).toHaveBeenCalledWith(RAVI.id, "mango 1357");
    expect(await screen.findByTestId("password-saved")).toHaveTextContent(
      "Ravi Kumar's phone is signed out. Tell Ravi Kumar the new password.",
    );
  });

  it("switch off asks first in plain words, then calls the action", async () => {
    const switchOff = vi.fn(async () => ok);
    renderPage({ actions: fakeActions({ switchOff }) });
    fireEvent.click(screen.getByRole("button", { name: "Switch off Ravi Kumar" }));
    const sheet = within(await screen.findByRole("alertdialog"));
    expect(sheet.getByText("Switch off Ravi Kumar?")).toBeInTheDocument();
    expect(sheet.getByText(/Payments still saved on the phone are not lost/)).toBeInTheDocument();
    expect(switchOff).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(sheet.getByRole("button", { name: "Switch off" }));
    });
    expect(switchOff).toHaveBeenCalledWith(RAVI.id);
    expect(await screen.findByText("Ravi Kumar is switched off.")).toBeInTheDocument();
  });

  it("switch on and sign out a phone; a failure is shown in words", async () => {
    const switchOn = vi.fn(async () => ok);
    const signOutPhone = vi.fn(async () => teamFailure({ code: "NOT_FOUND" }));
    renderPage({ actions: fakeActions({ switchOn, signOutPhone }) });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Switch on Suresh Pal" }));
    });
    await waitFor(() => expect(switchOn).toHaveBeenCalledWith(SURESH.id));
    expect(await screen.findByText("Suresh Pal can sign in again.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign out this phone" }));
    const sheet = within(await screen.findByRole("alertdialog"));
    expect(
      sheet.getByText(
        "Xiaomi Redmi 9A (ABC) will need the user name and password again. Payments saved on it stay on it.",
      ),
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(sheet.getByRole("button", { name: "Sign out phone" }));
    });
    expect(signOutPhone).toHaveBeenCalledWith(RAVI.phones[0]?.id);
    expect(
      await screen.findByText("This person or phone was not found. Reload the page."),
    ).toBeInTheDocument();
  });
});

describe("helpers", () => {
  it("maps service errors to words", () => {
    expect(
      teamFailure({
        code: "VALIDATION",
        details: { fields: [{ path: "password", code: "too_big" }] },
      }),
    ).toEqual({ ok: false, fields: { password: "password.too_long" } });
    expect(
      teamFailure({
        code: "VALIDATION",
        details: { fields: [{ path: "userId", code: "invalid" }] },
      }),
    ).toEqual({ ok: false, error: "unexpected" });
    expect(teamFailure({ code: "CONFLICT", details: { reason: "login_in_team" } })).toEqual({
      ok: false,
      fields: { login: "login.in_team" },
    });
    expect(teamFailure({ code: "CONFLICT", details: { reason: "email_taken" } })).toEqual({
      ok: false,
      fields: { email: "email.taken" },
    });
    expect(teamFailure({ code: "FORBIDDEN" })).toEqual({ ok: false, error: "not_owner" });
    expect(teamFailure({ code: "FORBIDDEN", details: { reason: "owner_account" } })).toEqual({
      ok: false,
      error: "owner_account",
    });
    expect(teamFailure({ code: "TENANT_READ_ONLY" })).toEqual({
      ok: false,
      error: "tenant_read_only",
    });
    expect(teamFailure({ code: "INTERNAL" })).toEqual({ ok: false, error: "unexpected" });
  });

  it("every field error key has words in English and Hindi", async () => {
    const hi = (await import("../../../../../messages/hi.json")).default;
    const codes: Record<string, string[]> = {
      name: ["required", "too_long"],
      mobile: ["required", "invalid"],
      email: ["required", "invalid", "too_long", "taken"],
      login: ["required", "too_short", "too_long", "bad_characters", "taken", "in_team"],
      password: ["required", "too_short", "too_long", "too_simple", "same_as_login"],
    };
    for (const [field, list] of Object.entries(codes)) {
      for (const code of list) {
        const enGroup = (en.team.error as unknown as Record<string, Record<string, string>>)[field];
        const hiGroup = (hi.team.error as unknown as Record<string, Record<string, string>>)[field];
        expect(enGroup?.[code], `${field}.${code}`).toBeTruthy();
        expect(hiGroup?.[code], `${field}.${code}`).toBeTruthy();
      }
    }
  });

  it("builds the WhatsApp link: app link and user name, never a password", () => {
    const t = (key: string, values?: Record<string, string | number>) =>
      key === "share_message"
        ? `${values?.business}|${values?.app}|${values?.app_url}|${values?.login}`
        : key;
    const text = shareMessage(t, { business: "Test Cable", app: "Cable Billing", login: "98765" });
    expect(text).toBe(`Test Cable|Cable Billing|${LINEMAN_APP_URL}|98765`);
    expect(whatsAppShareUrl("9876501234", "hi there")).toBe(
      "https://wa.me/919876501234?text=hi%20there",
    );
    expect(whatsAppShareUrl("+91 98765 01234", "x")).toBe("https://wa.me/919876501234?text=x");
    expect(whatsAppShareUrl(null, "x")).toBe("https://wa.me/?text=x");
    expect(whatsAppShareUrl("12345", "x")).toBe("https://wa.me/?text=x");
    // The real English message has no password placeholder at all.
    expect(en.team.share_message).not.toMatch(/\{password\}/);
    expect(en.team.share_message).toContain("{login}");
    expect(en.team.share_message).toContain("{app_url}");
  });

  it("groups a mobile for reading", () => {
    expect(groupMobile("9876501234")).toBe("98765 01234");
    expect(groupMobile("+447700900123")).toBe("+447700900123");
    expect(groupMobile(null)).toBeNull();
  });
});
