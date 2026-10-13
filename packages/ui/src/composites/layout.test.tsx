// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../primitives/Button";
import { axeViolations } from "../primitives/test-helpers";
import { EmptyState } from "./EmptyState";
import { LanguageSwitch, type LanguageSwitchOption } from "./LanguageSwitch";
import { PageHeader } from "./PageHeader";

describe("PageHeader", () => {
  it("has the title as h1 and one primary action pinned to the bottom on phones", async () => {
    render(
      <main>
        <PageHeader
          title="Customers"
          description="Everyone who pays you."
          action={
            <Button size="lg" icon="add">
              Add customer
            </Button>
          }
        />
      </main>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Customers" })).toBeInTheDocument();
    expect(screen.getByText("Everyone who pays you.")).toBeInTheDocument();
    const slot = screen
      .getByRole("button", { name: "Add customer" })
      .closest('[data-slot="page-action"]');
    expect(slot).toHaveClass("fixed", "bottom-0", "inset-x-0", "sm:static");
    expect(await axeViolations()).toEqual([]);
  });

  it("inline placement keeps the action next to the title; level 2 heading", () => {
    render(
      <PageHeader
        title="Bills"
        headingLevel={2}
        actionPlacement="inline"
        action={<Button>Preview</Button>}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Bills" })).toBeInTheDocument();
    const slot = screen.getByRole("button").closest('[data-slot="page-action"]');
    expect(slot).not.toHaveClass("fixed");
  });

  it("renders without client JavaScript (server component friendly)", () => {
    const html = renderToStaticMarkup(<PageHeader title="Home" />);
    expect(html).toContain("<h1");
    expect(html).not.toContain("page-action");
  });
});

describe("EmptyState", () => {
  it("is icon + one sentence + one action", async () => {
    render(
      <EmptyState
        icon="customer"
        message="No customers yet. Add your first customer."
        action={<Button icon="add">Add customer</Button>}
      />,
    );
    expect(screen.getByText("No customers yet. Add your first customer.")).toBeInTheDocument();
    const icon = document.querySelector('svg[data-icon="customer"]');
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).toHaveClass("text-text-muted");
    expect(screen.getByRole("button", { name: "Add customer" })).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });
});

const LANGUAGES: LanguageSwitchOption[] = [
  { value: "en", short: "EN", name: "English" },
  { value: "hi", short: "हिं", name: "हिंदी" },
];

describe("LanguageSwitch", () => {
  it("shows EN | हिं, names each language in full, marks the current one", async () => {
    render(<LanguageSwitch options={LANGUAGES} value="hi" label="भाषा" action={vi.fn()} />);
    const form = screen.getByRole("form", { name: "भाषा" });
    expect(form).toHaveTextContent("ENहिं");
    const english = screen.getByRole("button", { name: "English" });
    const hindi = screen.getByRole("button", { name: "हिंदी" });
    expect(english).toHaveAttribute("aria-pressed", "false");
    expect(hindi).toHaveAttribute("aria-pressed", "true");
    expect(hindi).toHaveAttribute("lang", "hi");
    expect(hindi).toHaveClass("bg-accent", "min-h-touch-min", "min-w-touch-min");
    expect(await axeViolations()).toEqual([]);
  });

  it("submits the chosen locale to the action (the app's setLocale)", async () => {
    const action = vi.fn();
    render(<LanguageSwitch options={LANGUAGES} value="en" label="Language" action={action} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "हिंदी" }));
    await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
    const formData = action.mock.calls[0]?.[0] as FormData;
    expect(formData.get("locale")).toBe("hi");
  });
});
