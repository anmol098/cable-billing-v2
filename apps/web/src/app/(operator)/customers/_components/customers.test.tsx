import { CUSTOMER_FIELD_LIMITS } from "@cb/core";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/test/intl";
import { AddCustomerForm } from "../new/add-customer-form";
import { CustomerFields } from "./customer-fields";
import { CustomerTabs } from "./customer-tabs";
import { customerFormStateFor } from "./form-errors";
import { EMPTY_VALUES, valuesFrom } from "./form-state";
import { FIELD_LIMITS } from "./limits";
import { searchHref } from "./search-href";
import { customerTabHref } from "./tab-list";

const navigation = vi.hoisted(() => ({ pathname: "/customers/c1" }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));

const AREAS = [
  { id: "a1", name: "North", archived: false },
  { id: "a2", name: "Old Colony", archived: true },
];
const VALUES = { ...EMPTY_VALUES, customerCode: "A 101", name: "Ramesh" };

describe("customer form errors", () => {
  it("shows a taken code under the code field, with the customer that has it", () => {
    const state = customerFormStateFor(
      {
        code: "CONFLICT",
        details: { field: "customerCode", reason: "duplicate_code", customerId: "c9" },
      },
      VALUES,
    );
    expect(state).toEqual({
      error: "fix_fields",
      fields: { customerCode: "code_taken" },
      values: VALUES,
      takenBy: "c9",
    });
    // The unique index (a race) gives the same answer.
    expect(
      customerFormStateFor(
        { code: "CONFLICT", details: { constraint: "customers_operator_code_unique" } },
        VALUES,
      ).fields,
    ).toEqual({ customerCode: "code_taken" });
  });

  it("maps field problems, missing areas and read-only mode", () => {
    const validation = customerFormStateFor(
      {
        code: "VALIDATION",
        details: {
          fields: [
            { path: "name", code: "too_small" },
            { path: "phone", code: "custom" },
            { path: "customerCode", code: "custom" },
            { path: "areaId", code: "archived" },
          ],
        },
      },
      VALUES,
    );
    expect(validation.fields).toEqual({
      name: "required",
      phone: "phone_invalid",
      customerCode: "too_long",
      areaId: "area_archived",
    });
    expect(customerFormStateFor({ code: "NOT_FOUND" }, VALUES).fields).toEqual({
      areaId: "area_missing",
    });
    expect(customerFormStateFor({ code: "TENANT_READ_ONLY" }, VALUES).error).toBe("read_only");
    expect(customerFormStateFor({ code: "INTERNAL" }, VALUES).error).toBe("unexpected");
  });

  it("reads the typed values and keeps the browser limits in step with the services", () => {
    const data = new FormData();
    data.set("name", "Sunita");
    data.set("phone", "98765 43210");
    expect(valuesFrom(data)).toEqual({ ...EMPTY_VALUES, name: "Sunita", phone: "98765 43210" });
    expect(FIELD_LIMITS).toEqual({ ...CUSTOMER_FIELD_LIMITS });
  });

  it("builds list URLs without empty values", () => {
    expect(searchHref("/customers", { q: " 1045 ", area: "", status: "active" })).toBe(
      "/customers?q=1045&status=active",
    );
    expect(searchHref("/customers", { q: "" })).toBe("/customers");
  });
});

describe("CustomerFields", () => {
  it("has six labelled fields; the area list hides archived areas", () => {
    renderWithIntl(
      <CustomerFields
        mode="new"
        areas={AREAS}
        nextAutoCode="46"
        values={EMPTY_VALUES}
        state={{}}
      />,
    );
    const code = screen.getByLabelText("Customer code");
    expect(code).not.toBeRequired();
    expect(code).toHaveAccessibleDescription("Leave it empty to use the next number (46).");
    expect(screen.getByLabelText("Name")).toBeRequired();
    expect(screen.getByLabelText("Mobile no.")).toHaveAttribute("type", "tel");
    expect(screen.getByLabelText("Other mobile no. (optional)")).toHaveAttribute(
      "inputmode",
      "tel",
    );
    const area = screen.getByLabelText("Area");
    expect(
      within(area)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["No area", "North"]);
    expect(screen.getByLabelText("Address (optional)")).toBeInTheDocument();
  });

  it("shows a taken code in words, with a link to the customer that has it", () => {
    renderWithIntl(
      <CustomerFields
        mode="edit"
        areas={AREAS}
        values={{ ...VALUES, areaId: "a2" }}
        state={{ error: "fix_fields", fields: { customerCode: "code_taken" }, takenBy: "c9" }}
      />,
    );
    const code = screen.getByLabelText("Customer code");
    expect(code).toBeRequired();
    expect(code).toHaveAttribute("aria-invalid", "true");
    expect(code).toHaveAccessibleDescription(/Code A 101 is already used by another customer\./);
    expect(screen.getByRole("link", { name: "Open that customer" })).toHaveAttribute(
      "href",
      "/customers/c9",
    );
    // The customer's own archived area stays selectable.
    expect(screen.getByRole("option", { name: "Old Colony" })).toBeInTheDocument();
  });

  it("speaks Hindi", () => {
    renderWithIntl(
      <CustomerFields mode="new" areas={AREAS} nextAutoCode="7" values={EMPTY_VALUES} state={{}} />,
      "hi",
    );
    expect(screen.getByLabelText("ग्राहक कोड")).toBeInTheDocument();
    expect(screen.getByLabelText("मोबाइल नंबर")).toBeInTheDocument();
  });
});

describe("AddCustomerForm", () => {
  it("walks Customer → Connections → Check & save and shows what was typed", async () => {
    const action = vi.fn(async () => ({}));
    renderWithIntl(<AddCustomerForm action={action} areas={AREAS} nextAutoCode="46" />);
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Sunita Devi" } });
    fireEvent.change(screen.getByLabelText("Mobile no."), { target: { value: "98765 43210" } });
    fireEvent.change(screen.getByLabelText("Area"), { target: { value: "a1" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Next" })));
    expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
    expect(screen.getByText(/You can add set-top boxes \(VC numbers\) after saving/)).toBeVisible();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Next" })));
    expect(screen.getByText("Step 3 of 3")).toBeInTheDocument();
    const check = document.querySelector("[data-check=customer]") as HTMLElement;
    expect(within(check).getByText("Next number (46)")).toBeInTheDocument();
    expect(within(check).getByText("Sunita Devi")).toBeInTheDocument();
    expect(within(check).getByText("98765 43210")).toBeInTheDocument();
    expect(within(check).getByText("North")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save customer" })).toHaveAttribute("type", "submit");
  });

  it("does not leave step 1 without a name", async () => {
    renderWithIntl(
      <AddCustomerForm action={vi.fn(async () => ({}))} areas={AREAS} nextAutoCode="1" />,
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Next" })));
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
  });

  it("goes back to step 1 with the problem after a failed save", async () => {
    const action = vi.fn(async () => ({
      error: "fix_fields" as const,
      fields: { customerCode: "code_taken" as const },
      values: { ...EMPTY_VALUES, customerCode: "101", name: "Ramesh" },
      takenBy: "c1",
    }));
    renderWithIntl(<AddCustomerForm action={action} areas={AREAS} nextAutoCode="1" />);
    fireEvent.change(screen.getByLabelText("Customer code"), { target: { value: "101" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ramesh" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Next" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Next" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save customer" })));
    await waitFor(() => expect(screen.getByText("Step 1 of 3")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("Please fix the marked boxes.");
    expect(screen.getByLabelText("Customer code")).toHaveValue("101");
    expect(screen.getByText("Code 101 is already used by another customer.")).toBeVisible();
  });
});

describe("CustomerTabs", () => {
  it("links every tab and marks the current one", () => {
    navigation.pathname = "/customers/c1/bills";
    const labels = {
      summary: "Summary",
      connections: "Connections (VC)",
      bills: "Bills",
      payments: "Payments",
      history: "History",
    };
    renderWithIntl(<CustomerTabs customerId="c1" labels={labels} label="Customer pages" />);
    const nav = screen.getByRole("navigation", { name: "Customer pages" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/customers/c1",
      "/customers/c1/connections",
      "/customers/c1/bills",
      "/customers/c1/payments",
      "/customers/c1/history",
    ]);
    expect(within(nav).getByRole("link", { name: "Bills" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Summary" })).not.toHaveAttribute("aria-current");
    expect(customerTabHref("x", "summary")).toBe("/customers/x");
  });
});
