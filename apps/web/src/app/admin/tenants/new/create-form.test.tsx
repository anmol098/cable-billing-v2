/** The "Add operator" form (T-086): labels in English and Hindi, errors in words, values kept. */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/test/intl";
import type { CreateTenantState } from "../actions";
import { CreateTenantForm } from "./create-form";

const ID = "0199a0b0-0000-7000-8000-00000000c0de";

describe("CreateTenantForm", () => {
  it("has six labelled fields and sends the operator id made by the page", async () => {
    const action = vi.fn(
      async (_s: CreateTenantState, form: FormData): Promise<CreateTenantState> => ({
        error: "email_taken",
        values: { businessName: String(form.get("businessName")), ownerEmail: "a@b.test" },
      }),
    );
    renderWithIntl(<CreateTenantForm operatorId={ID} action={action} />);
    for (const label of [
      "Business name",
      "Business phone (optional)",
      "Owner's name",
      "Owner's email",
      "Owner's mobile number",
      "Owner's language",
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    fireEvent.change(screen.getByLabelText("Business name"), { target: { value: "Ganesh Cable" } });
    fireEvent.click(screen.getByRole("button", { name: "Add operator" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const form = action.mock.calls[0]?.[1] as FormData;
    expect(form.get("operatorId")).toBe(ID);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This email already has an account.",
    );
    expect(screen.getByLabelText("Business name")).toHaveValue("Ganesh Cable");
  });

  it("marks the wrong fields", async () => {
    const action = vi.fn(
      async (): Promise<CreateTenantState> => ({ error: "validation", fields: ["ownerMobile"] }),
    );
    renderWithIntl(<CreateTenantForm operatorId={ID} action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Add operator" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Please check the marked fields.");
    expect(screen.getByLabelText("Owner's mobile number")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Owner's name")).not.toHaveAttribute("aria-invalid");
  });

  it("reads in Hindi", () => {
    renderWithIntl(<CreateTenantForm operatorId={ID} action={vi.fn()} />, "hi");
    expect(screen.getByLabelText("बिज़नेस का नाम")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ऑपरेटर जोड़ें" })).toBeInTheDocument();
  });
});
