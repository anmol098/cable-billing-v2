// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card } from "./Card";
import { Divider } from "./Divider";
import { Spinner } from "./Spinner";
import { STATUS_PILL_STYLES, StatusPill, type StatusPillVariant } from "./StatusPill";
import { axeViolations } from "./test-helpers";
import { VisuallyHidden } from "./VisuallyHidden";

describe("axeViolations", () => {
  it("is not vacuous: reports an unlabelled field and a nameless button", async () => {
    render(
      <div>
        <input type="text" />
        <button type="button" />
      </div>,
    );
    const violations = (await axeViolations()).join("\n");
    expect(violations).toContain("label");
    expect(violations).toContain("button-name");
  });
});

describe("StatusPill", () => {
  it.each([
    ["cash", "cash", "text-cash"],
    ["upi", "upi", "text-upi"],
    ["pending", "pending", "text-pending"],
    ["success", "success", "text-success"],
    ["danger", "danger", "text-danger"],
  ] as const)("%s: icon %s + colour %s + word", async (variant, icon, colour) => {
    const { container } = render(<StatusPill variant={variant} label="Word" />);
    const pill = container.firstElementChild;
    expect(pill).toHaveClass(colour, "rounded-full", "border-hairline");
    expect(pill).toHaveTextContent("Word");
    expect(pill?.querySelector(`svg[data-icon="${icon}"]`)).toHaveAttribute("aria-hidden", "true");
    expect(await axeViolations()).toEqual([]);
  });

  it("covers every variant of PLAN §2.2 rule 4", () => {
    expect(Object.keys(STATUS_PILL_STYLES).sort()).toEqual([
      "cash",
      "danger",
      "pending",
      "success",
      "upi",
    ] satisfies StatusPillVariant[]);
  });

  it("accepts an icon override", () => {
    const { container } = render(<StatusPill variant="pending" icon="waiting" label="Waiting" />);
    expect(container.querySelector('svg[data-icon="waiting"]')).not.toBeNull();
  });
});

describe("Spinner", () => {
  it("with a label is a status region announcing it", () => {
    render(<Spinner label="Loading" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
  });

  it("without a label is decorative", () => {
    const { container } = render(<Spinner />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("Card, Divider, VisuallyHidden", () => {
  it("Card is a hairline box and can render another element", async () => {
    const { container } = render(
      <>
        <Card>Plain</Card>
        <Card asChild>
          <section aria-label="Due">Due</section>
        </Card>
      </>,
    );
    expect(container.firstElementChild).toHaveClass(
      "border-hairline",
      "border-border",
      "rounded-lg",
    );
    expect(screen.getByRole("region", { name: "Due" })).toHaveClass("border-hairline");
    expect(await axeViolations()).toEqual([]);
  });

  it("Divider is decorative by default and a separator when it matters", async () => {
    const { container } = render(
      <div>
        <Divider />
        <Divider decorative={false} orientation="vertical" />
      </div>,
    );
    const [decorative] = container.querySelectorAll("[data-orientation]");
    expect(decorative).toHaveAttribute("aria-hidden", "true");
    expect(decorative).toHaveClass("border-t-hairline");
    const separator = screen.getByRole("separator");
    expect(separator).toHaveAttribute("aria-orientation", "vertical");
    expect(separator).toHaveClass("border-l-hairline");
    expect(await axeViolations()).toEqual([]);
  });

  it("VisuallyHidden keeps text for screen readers", () => {
    render(
      <button type="button">
        <VisuallyHidden>Close</VisuallyHidden>
      </button>,
    );
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.getByText("Close")).toHaveClass("sr-only");
  });
});
