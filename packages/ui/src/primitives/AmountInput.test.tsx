// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AmountInput, type AmountInputProps } from "./AmountInput";
import { axeViolations } from "./test-helpers";

function setup(props: Partial<AmountInputProps> = {}) {
  const onValueChange = vi.fn();
  const onReject = vi.fn();
  render(
    <form aria-label="pay">
      <label htmlFor="amount">Amount</label>
      <AmountInput id="amount" onValueChange={onValueChange} onReject={onReject} {...props} />
    </form>,
  );
  const input = screen.getByLabelText("Amount");
  if (!(input instanceof HTMLInputElement)) throw new Error("not an input");
  return { input, onValueChange, onReject, user: userEvent.setup() };
}

describe("AmountInput", () => {
  it("shows ₹, asks phones for the number pad and has no axe violations", async () => {
    const { input } = setup();
    expect(input).toHaveAttribute("inputmode", "numeric");
    expect(input).toHaveAttribute("type", "text");
    expect(screen.getByText("₹")).toHaveAttribute("aria-hidden", "true");
    expect(await axeViolations()).toEqual([]);
  });

  it("returns whole rupees as integer paise", async () => {
    const { input, onValueChange, user } = setup();
    await user.type(input, "450");
    expect(input).toHaveValue("450");
    expect(onValueChange).toHaveBeenLastCalledWith(45000);
    expect(onValueChange.mock.calls.map(([paise]) => paise)).toEqual([400, 4500, 45000]);
    for (const [paise] of onValueChange.mock.calls) expect(Number.isInteger(paise)).toBe(true);
  });

  it("rejects a decimal point: the value stays whole rupees", async () => {
    const { input, onValueChange, onReject, user } = setup();
    await user.type(input, "12.5");
    expect(onReject).toHaveBeenCalledWith("decimal");
    // "." was refused; "5" then appended to "12".
    expect(input).toHaveValue("125");
    expect(onValueChange).toHaveBeenLastCalledWith(12500);
  });

  it("rejects pasted decimals and negatives without changing the value", () => {
    const { input, onValueChange, onReject } = setup({ defaultValue: 30000 });
    expect(input).toHaveValue("300");
    fireEvent.change(input, { target: { value: "12.50" } });
    expect(onReject).toHaveBeenLastCalledWith("decimal");
    expect(input).toHaveValue("300");
    fireEvent.change(input, { target: { value: "-50" } });
    expect(onReject).toHaveBeenLastCalledWith("negative");
    expect(input).toHaveValue("300");
    fireEvent.change(input, { target: { value: "5a" } });
    expect(onReject).toHaveBeenLastCalledWith("invalid");
    expect(input).toHaveValue("300");
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("normalises pasted grouping and Devanagari digits", () => {
    const { input, onValueChange } = setup();
    fireEvent.change(input, { target: { value: "1,23,456" } });
    expect(input).toHaveValue("123456");
    expect(onValueChange).toHaveBeenLastCalledWith(12345600);
    fireEvent.change(input, { target: { value: "४५०" } });
    expect(input).toHaveValue("450");
    expect(onValueChange).toHaveBeenLastCalledWith(45000);
  });

  it("reports null when cleared", async () => {
    const { input, onValueChange, user } = setup({ defaultValue: 500 });
    await user.clear(input);
    expect(onValueChange).toHaveBeenLastCalledWith(null);
  });

  it("enforces maxPaise", () => {
    const { input, onReject } = setup({ maxPaise: 100000 });
    fireEvent.change(input, { target: { value: "1001" } });
    expect(onReject).toHaveBeenLastCalledWith("too-large");
    expect(input).toHaveValue("");
    fireEvent.change(input, { target: { value: "1000" } });
    expect(input).toHaveValue("1000");
  });

  it("submits paise under `name` from a hidden input", async () => {
    const { input, user } = setup({ name: "amount_paise" });
    await user.type(input, "250");
    const form = screen.getByRole("form", { name: "pay" });
    if (!(form instanceof HTMLFormElement)) throw new Error("no form");
    const data = new FormData(form);
    expect(data.get("amount_paise")).toBe("25000");
    expect([...data.keys()]).toEqual(["amount_paise"]);
  });

  it("follows a controlled value", async () => {
    function Controlled() {
      const [paise, setPaise] = useState<number | null>(10000);
      return (
        <>
          <AmountInput aria-label="Amount" value={paise} onValueChange={setPaise} />
          <output>{String(paise)}</output>
          <button type="button" onClick={() => setPaise(70000)}>
            set
          </button>
        </>
      );
    }
    render(<Controlled />);
    const user = userEvent.setup();
    const input = screen.getByLabelText("Amount");
    expect(input).toHaveValue("100");
    await user.type(input, "5");
    expect(input).toHaveValue("1005");
    expect(screen.getByRole("status")).toHaveTextContent("100500");
    await user.click(screen.getByRole("button", { name: "set" }));
    expect(input).toHaveValue("700");
  });

  it("marks invalid", () => {
    const { input } = setup({ invalid: true });
    expect(input).toHaveAttribute("aria-invalid", "true");
  });
});
