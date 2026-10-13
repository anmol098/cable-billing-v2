// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button";
import { Checkbox } from "./Checkbox";
import { IconButton } from "./IconButton";
import { Input } from "./Input";
import { RadioCards } from "./RadioCards";
import { Select } from "./Select";
import { Textarea } from "./Textarea";
import { axeViolations } from "./test-helpers";

describe("Button", () => {
  it("is a keyboard-operable button with icon + word and the touch-min height", async () => {
    const onClick = vi.fn();
    render(
      <Button icon="cash" onClick={onClick}>
        Collect
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Collect" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("min-h-touch-min", "bg-accent", "text-on-accent");
    expect(button.className).toContain("focus-visible:outline-focus");
    expect(button.querySelector('svg[data-icon="cash"]')).toHaveAttribute("aria-hidden", "true");

    const user = userEvent.setup();
    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(await axeViolations()).toEqual([]);
  });

  it.each([
    ["primary", "bg-accent"],
    ["secondary", "bg-bg"],
    ["quiet", "bg-transparent"],
    ["danger", "bg-danger"],
  ] as const)("variant %s uses %s", (variant, className) => {
    render(<Button variant={variant}>Go</Button>);
    expect(screen.getByRole("button")).toHaveClass(className);
  });

  it("size lg uses the primary-button height token", () => {
    render(<Button size="lg">Save</Button>);
    expect(screen.getByRole("button")).toHaveClass("min-h-primary-button");
  });

  it("loading: busy, disabled, spinner instead of icon, optional loading word", async () => {
    const onClick = vi.fn();
    render(
      <Button icon="cash" loading loadingLabel="Saving…" onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Saving…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector("[data-spinner]")).not.toBeNull();
    expect(button.querySelector("svg[data-icon]")).toBeNull();
    // Keeps its colours while busy (no greyed-out disabled look).
    expect(button).toHaveClass("bg-accent");
    expect(button.className).not.toContain("disabled:bg-surface");
    await userEvent.setup().click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(await axeViolations()).toEqual([]);
  });

  it("asChild styles a link and keeps the icon", async () => {
    render(
      <Button asChild icon="add" variant="secondary">
        <a href="/customers/new">Add customer</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Add customer" });
    expect(link).toHaveClass("bg-bg", "min-h-touch-min");
    expect(link.querySelector('svg[data-icon="add"]')).not.toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it("respects type=submit", () => {
    render(<Button type="submit">Save</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "submit");
  });
});

describe("IconButton", () => {
  it("icon-only: named by aria-label, shows a tooltip on keyboard focus", async () => {
    const onClick = vi.fn();
    render(<IconButton icon="print" label="Print" onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Print" });
    expect(button).toHaveClass("size-touch-min");
    expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");

    const user = userEvent.setup();
    await user.tab();
    expect(button).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Print");
    await user.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(await axeViolations()).toEqual([]);
  });

  it("showLabel: icon + visible word, no tooltip", async () => {
    render(<IconButton icon="whatsapp" label="WhatsApp" showLabel />);
    const button = screen.getByRole("button", { name: "WhatsApp" });
    expect(button).not.toHaveAttribute("aria-label");
    expect(button).toHaveTextContent("WhatsApp");
    await userEvent.setup().tab();
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });
});

describe("text fields", () => {
  it("Input, Textarea and Select are labelled, focusable, token-styled and pass axe", async () => {
    render(
      <form>
        <label htmlFor="name">Name</label>
        <Input id="name" placeholder="Ramesh" />
        <label htmlFor="note">Note</label>
        <Textarea id="note" />
        <label htmlFor="area">Area</label>
        <Select id="area" placeholder="Choose area" defaultValue="" required>
          <option value="north">North</option>
          <option value="south">South</option>
        </Select>
      </form>,
    );
    const user = userEvent.setup();
    const name = screen.getByLabelText("Name");
    const note = screen.getByLabelText("Note");
    const area = screen.getByLabelText("Area");
    for (const field of [name, note, area]) {
      expect(field).toHaveClass("min-h-touch-min", "border-hairline", "border-border");
      expect(field.className).toContain("focus-visible:outline-focus");
    }
    await user.tab();
    expect(name).toHaveFocus();
    await user.keyboard("Ramesh");
    expect(name).toHaveValue("Ramesh");
    await user.tab();
    expect(note).toHaveFocus();
    await user.tab();
    expect(area).toHaveFocus();
    expect(area).toHaveValue("");
    expect(screen.getByRole("option", { name: "Choose area" })).toBeDisabled();
    await user.selectOptions(area, "south");
    expect(area).toHaveValue("south");
    expect(await axeViolations()).toEqual([]);
  });

  it("invalid sets aria-invalid", () => {
    render(<Input aria-label="Mobile" invalid />);
    expect(screen.getByLabelText("Mobile")).toHaveAttribute("aria-invalid", "true");
  });
});

describe("Checkbox", () => {
  it("toggles by keyboard and by clicking its word; description is announced", async () => {
    const onChange = vi.fn();
    render(<Checkbox label="Send bill" description="On WhatsApp" onChange={onChange} />);
    const box = screen.getByRole("checkbox", { name: "Send bill" });
    expect(box).toHaveAccessibleDescription("On WhatsApp");
    const user = userEvent.setup();
    await user.tab();
    expect(box).toHaveFocus();
    await user.keyboard(" ");
    expect(box).toBeChecked();
    await user.click(screen.getByText("Send bill"));
    expect(box).not.toBeChecked();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(box.closest("label")).toHaveClass("min-h-touch-min");
    expect(await axeViolations()).toEqual([]);
  });
});

describe("RadioCards", () => {
  const options = [
    { value: "cash", label: "Cash", icon: "cash", iconClassName: "text-cash" },
    { value: "upi", label: "UPI", icon: "upi", iconClassName: "text-upi", description: "QR" },
    { value: "card", label: "Card", disabled: true },
  ] as const;

  it("is a radio group: arrow keys move and select, Tab enters at the checked tile", async () => {
    const onValueChange = vi.fn();
    render(
      <RadioCards
        aria-label="Payment method"
        options={options}
        defaultValue="cash"
        onValueChange={onValueChange}
      />,
    );
    const group = screen.getByRole("radiogroup", { name: "Payment method" });
    expect(group).toBeInTheDocument();
    const cash = screen.getByRole("radio", { name: "Cash" });
    const upi = screen.getByRole("radio", { name: /UPI/ });
    expect(cash).toBeChecked();
    expect(cash).toHaveClass("min-h-touch-min");
    expect(screen.getByRole("radio", { name: "Card" })).toBeDisabled();

    const user = userEvent.setup();
    await user.tab();
    expect(cash).toHaveFocus();
    // Hold the key: Radix moves focus on the next tick and selects while the arrow is down,
    // as a browser does (user-event would otherwise release it before focus moves).
    await user.keyboard("{ArrowDown>}");
    await vi.waitFor(() => expect(upi).toHaveFocus());
    await user.keyboard("{/ArrowDown}");
    expect(upi).toBeChecked();
    expect(onValueChange).toHaveBeenLastCalledWith("upi");
    expect(await axeViolations()).toEqual([]);
  });

  it("submits its value with a name", async () => {
    render(
      <form aria-label="f">
        <RadioCards aria-label="Method" name="method" options={options} defaultValue="upi" />
      </form>,
    );
    const form = screen.getByRole("form", { name: "f" });
    if (!(form instanceof HTMLFormElement)) throw new Error("no form");
    expect(new FormData(form).get("method")).toBe("upi");
  });
});
