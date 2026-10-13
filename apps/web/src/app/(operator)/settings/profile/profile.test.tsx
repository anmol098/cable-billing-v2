import { ToastProvider } from "@cb/ui";
import { act, fireEvent, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/test/intl";
import {
  fieldErrorKey,
  type ProfileFormState,
  type ProfileValues,
  profileFormStateFor,
} from "./form-state";
import { ProfileForm } from "./profile-form";
import { ProfileView } from "./profile-view";

// Radix RadioGroup measures its items with ResizeObserver, which jsdom does not implement.
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const VALUES: ProfileValues = {
  name: "Shree Ram Cable",
  phone: "9876543210",
  address: "Station Road",
  receiptFooter: "Thank you",
  invoicePrefix: "SRC",
  defaultLanguage: "hi",
  midMonthStartPolicy: "start_next_month",
};

const withToasts = (ui: ReactElement) => (
  <ToastProvider closeLabel="Close" label="Notifications">
    {ui}
  </ToastProvider>
);

describe("profileFormStateFor", () => {
  it("maps field issues to words, first issue per field", () => {
    const state = profileFormStateFor(
      {
        code: "VALIDATION",
        details: {
          fields: [
            { path: "name", code: "too_small" },
            { path: "phone", code: "invalid_format" },
            { path: "invoicePrefix", code: "invalid_format" },
            { path: "invoicePrefix", code: "too_big" },
            { path: "receiptFooter", code: "custom" },
            { path: "midMonthStartPolicy", code: "invalid_value" },
            { path: "operatorId", code: "unrecognized_keys" },
          ],
        },
      },
      VALUES,
    );
    expect(state).toEqual({
      error: "fix_fields",
      fields: {
        name: "required",
        phone: "phone_invalid",
        invoicePrefix: "prefix_invalid",
        receiptFooter: "bad_characters",
        midMonthStartPolicy: "choose_one",
      },
      values: VALUES,
    });
  });

  it.each([
    ["FORBIDDEN", "not_owner"],
    ["TENANT_READ_ONLY", "tenant_read_only"],
    ["INTERNAL", "unexpected"],
    ["NOT_FOUND", "unexpected"],
  ])("maps %s to %s", (code, error) => {
    expect(profileFormStateFor({ code }, VALUES).error).toBe(error);
  });

  it("names too long fields", () => {
    expect(fieldErrorKey("address", "too_big")).toBe("too_long");
    expect(fieldErrorKey("defaultLanguage", "invalid_value")).toBe("choose_one");
  });
});

describe("ProfileForm (Owner)", () => {
  it("shows every field, the plain mid-month choice and a live bill number example", () => {
    renderWithIntl(
      withToasts(
        <ProfileForm
          title="Business details"
          initial={VALUES}
          exampleSuffix="-2610-00001"
          action={vi.fn(async () => ({}))}
        />,
      ),
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Business details");
    expect(screen.getByLabelText("Business name")).toHaveValue("Shree Ram Cable");
    expect(screen.getByLabelText("Office phone")).toHaveValue("9876543210");
    expect(screen.getByLabelText("Receipt message")).toHaveValue("Thank you");
    expect(
      screen.getByText("1 to 8 capital letters or numbers. Example: SRC-2610-00001"),
    ).toBeVisible();
    expect(screen.getByText(/Only new bills use it/)).toBeVisible();

    fireEvent.change(screen.getByLabelText("Bill number start"), { target: { value: "cb" } });
    expect(screen.getByText(/Example: CB-2610-00001/)).toBeVisible();

    const policy = screen.getByRole("radiogroup", { name: /Should it pay for this month/ });
    expect(within(policy).getByRole("radio", { name: /Start from next month/ })).toBeChecked();
    expect(
      within(policy).getByRole("radio", { name: /Charge the full month/ }),
    ).toHaveAccessibleName(/full rent for this month is added to the customer's next bill/);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
      "form",
      "business-profile",
    );
  });

  it("submits the typed values and shows field errors in words", async () => {
    const action = vi.fn(
      async (_state: ProfileFormState, formData: FormData): Promise<ProfileFormState> => ({
        error: "fix_fields",
        fields: { phone: "phone_invalid" },
        values: Object.fromEntries(formData) as unknown as ProfileValues,
      }),
    );
    renderWithIntl(
      withToasts(
        <ProfileForm
          title="Business details"
          initial={VALUES}
          exampleSuffix="-2610-00001"
          action={action}
        />,
      ),
    );
    fireEvent.change(screen.getByLabelText("Office phone"), { target: { value: "call me" } });
    fireEvent.click(screen.getByRole("radio", { name: /Charge the full month/ }));
    expect(screen.getByRole("radio", { name: /Charge the full month/ })).toBeChecked();
    await act(async () => {
      fireEvent.submit(document.getElementById("business-profile") as HTMLFormElement);
    });
    const sent = action.mock.calls[0]?.[1] as FormData;
    expect(Object.fromEntries(sent)).toMatchObject({
      name: "Shree Ram Cable",
      phone: "call me",
      invoicePrefix: "SRC",
      defaultLanguage: "hi",
      midMonthStartPolicy: "charge_full_month",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Please fix the boxes marked in red.",
    );
    expect(screen.getByLabelText("Office phone")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Office phone")).toHaveAccessibleDescription(
      /Write a phone number/,
    );
    expect(screen.getByLabelText("Office phone")).toHaveValue("call me");
  });

  it("shows the saved values and a toast after saving", async () => {
    const action = vi.fn(async () => ({
      saved: { changed: 1, at: 1, values: { ...VALUES, invoicePrefix: "CB" } },
    }));
    renderWithIntl(
      withToasts(
        <ProfileForm
          title="Business details"
          initial={VALUES}
          exampleSuffix="-2610-00001"
          action={action}
        />,
      ),
    );
    fireEvent.change(screen.getByLabelText("Bill number start"), { target: { value: " cb " } });
    await act(async () => {
      fireEvent.submit(document.getElementById("business-profile") as HTMLFormElement);
    });
    expect(await screen.findByText("Saved")).toBeVisible();
    expect(screen.getByLabelText("Bill number start")).toHaveValue("CB");
  });

  it("is in Hindi too", () => {
    renderWithIntl(
      withToasts(
        <ProfileForm
          title="बिज़नेस की जानकारी"
          initial={VALUES}
          exampleSuffix="-2610-00001"
          action={vi.fn()}
        />,
      ),
      "hi",
    );
    expect(screen.getByLabelText("बिज़नेस का नाम")).toBeVisible();
    expect(screen.getByRole("radio", { name: /अगले महीने से शुरू करें/ })).toBeChecked();
  });
});

describe("ProfileView (Staff / read-only)", () => {
  it("shows the values without a form or a Save button", () => {
    renderWithIntl(
      <ProfileView
        title="Business details"
        reason="not_owner"
        profile={{
          name: "Shree Ram Cable",
          phone: null,
          address: "Station Road\nNagpur",
          receiptFooter: null,
          invoicePrefix: "SRC",
          defaultLanguage: "en",
          midMonthStartPolicy: "charge_full_month",
        }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Only the owner can change this.");
    expect(screen.getByText("Shree Ram Cable")).toBeVisible();
    expect(screen.getAllByText("Not set")).toHaveLength(2);
    expect(screen.getByText("Charge the full month")).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("tells the Owner why when the tenant is read-only", () => {
    renderWithIntl(
      <ProfileView
        title="Business details"
        reason="tenant_read_only"
        profile={{
          name: "X",
          phone: "9876543210",
          address: null,
          receiptFooter: "Thanks",
          invoicePrefix: "INV",
          defaultLanguage: "hi",
          midMonthStartPolicy: "start_next_month",
        }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("View only. Pay for the app");
  });
});
