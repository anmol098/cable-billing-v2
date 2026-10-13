// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Amount, resolveAmountTone } from "./Amount";

function amountOf(container: HTMLElement): HTMLElement {
  const root = container.firstElementChild;
  if (!(root instanceof HTMLElement)) throw new Error("Amount did not render");
  return root;
}

describe("Amount", () => {
  it.each([
    [0, "₹0"],
    [9900, "₹99"],
    [10000000, "₹1,00,000"],
    [12345600, "₹1,23,456"],
    [123456789n, "₹12,34,567.89"],
  ])("formats %s paise as %s with tabular figures", (paise, text) => {
    render(<Amount paise={paise} />);
    const number = screen.getByText(text);
    expect(number).toHaveClass("font-numeric", "text-base");
  });

  it("shows a negative amount as credit: no minus sign, credit colour, credit word", () => {
    const { container } = render(<Amount paise={-50000} creditLabel="Credit" dueLabel="Due" />);
    const root = amountOf(container);
    expect(root).toHaveTextContent(/^₹500Credit$/);
    expect(root).not.toHaveTextContent("-");
    expect(root).toHaveAttribute("data-tone", "credit");
    expect(root).toHaveClass("text-credit");
    expect(root).not.toHaveClass("text-due");
  });

  it("is credit for negatives whatever the tone", () => {
    for (const tone of ["neutral", "balance", "due", "credit"] as const) {
      expect(resolveAmountTone(-1, tone)).toBe("credit");
      expect(resolveAmountTone(-1n, tone)).toBe("credit");
    }
  });

  it("colours a positive balance as due, with its word", () => {
    const { container } = render(
      <Amount paise={45000} tone="balance" dueLabel="Due" creditLabel="Credit" />,
    );
    const root = amountOf(container);
    expect(root).toHaveAttribute("data-tone", "due");
    expect(root).toHaveClass("text-due");
    expect(root).toHaveTextContent(/^₹450Due$/);
  });

  it("keeps a zero balance and neutral amounts in the text colour, without a word", () => {
    const zero = amountOf(
      render(<Amount paise={0} tone="balance" dueLabel="Due" creditLabel="Credit" />).container,
    );
    expect(zero).toHaveAttribute("data-tone", "neutral");
    expect(zero).toHaveClass("text-text");
    expect(zero).toHaveTextContent(/^₹0$/);

    const plain = amountOf(render(<Amount paise={45000} dueLabel="Due" />).container);
    expect(plain).toHaveAttribute("data-tone", "neutral");
    expect(plain).toHaveTextContent(/^₹450$/);
  });

  it("applies the type size token and weight", () => {
    render(<Amount paise={100} size="amount" weight="regular" data-testid="a" />);
    expect(screen.getByText("₹1")).toHaveClass("text-amount");
    expect(screen.getByTestId("a")).toHaveClass("font-regular");
  });

  it("refuses non-integer paise", () => {
    expect(() => render(<Amount paise={10.5} />)).toThrow(RangeError);
  });
});
