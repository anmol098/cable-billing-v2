import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/test/intl";
import { LocaleSwitch } from "./locale-switch";

describe("LocaleSwitch", () => {
  it("names each language in its own script and marks the current one", () => {
    renderWithIntl(<LocaleSwitch current="en" action={vi.fn()} />);

    const english = screen.getByRole("button", { name: "English" });
    const hindi = screen.getByRole("button", { name: "हिंदी" });
    expect(english).toHaveAttribute("aria-pressed", "true");
    expect(hindi).toHaveAttribute("aria-pressed", "false");
    expect(hindi).toHaveAttribute("lang", "hi");
    expect(screen.getByRole("form", { name: "Language" })).toBeInTheDocument();
  });

  it("uses Hindi labels around the buttons when the page is Hindi", () => {
    renderWithIntl(<LocaleSwitch current="hi" action={vi.fn()} />, "hi");

    expect(screen.getByRole("form", { name: "भाषा" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "हिंदी" })).toHaveAttribute("aria-pressed", "true");
  });

  it("submits the chosen locale to the action", async () => {
    const action = vi.fn();
    renderWithIntl(<LocaleSwitch current="en" action={action} />);

    fireEvent.click(screen.getByRole("button", { name: "हिंदी" }));

    await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
    const formData = action.mock.calls[0]?.[0] as FormData;
    expect(formData.get("locale")).toBe("hi");
  });

  it("only uses token utilities (no raw colours or pixel sizes)", () => {
    renderWithIntl(<LocaleSwitch current="en" action={vi.fn()} />);

    for (const button of screen.getAllByRole("button")) {
      expect(button.className).not.toMatch(/#|\[|px\]|rgb|hsl/);
      expect(button.className).toContain("min-h-touch-min");
    }
  });
});
