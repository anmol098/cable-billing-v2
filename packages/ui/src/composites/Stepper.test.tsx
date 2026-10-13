// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Input } from "../primitives/Input";
import { RadioCards } from "../primitives/RadioCards";
import { axeViolations } from "../primitives/test-helpers";
import { countStepFields, STEPPER_MAX_FIELDS, Stepper, type StepperProps } from "./Stepper";

const STEPS: StepperProps["steps"] = [
  {
    id: "customer",
    title: "Customer",
    content: (
      <>
        <label htmlFor="step-name">Name</label>
        <Input id="step-name" name="name" required />
      </>
    ),
  },
  {
    id: "connections",
    title: "Connections",
    content: (
      <>
        <label htmlFor="step-vc">VC number</label>
        <Input id="step-vc" name="vc" />
      </>
    ),
  },
  { id: "check", title: "Check & save", content: <p>All good.</p> },
];

const LABELS = {
  backLabel: "Back",
  nextLabel: "Next",
  finishLabel: "Save",
  progressLabel: (current: number, total: number) => `Step ${current} of ${total}`,
};

function visibleStep(): string | undefined {
  const panels = [...document.querySelectorAll<HTMLElement>("[data-step]")];
  return panels.find((panel) => !panel.hidden)?.dataset.step;
}

describe("Stepper", () => {
  it("navigates Next and Back, one step visible at a time, focus on the new step's heading", async () => {
    const onStepChange = vi.fn();
    render(<Stepper steps={STEPS} onStepChange={onStepChange} {...LABELS} />);
    const user = userEvent.setup();

    expect(visibleStep()).toBe("customer");
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByRole("listitem", { current: "step" })).toHaveTextContent("Customer");

    await user.type(screen.getByRole("textbox", { name: "Name" }), "Ramesh");
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(visibleStep()).toBe("connections");
    expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Connections" })).toHaveFocus();
    expect(screen.getByRole("listitem", { current: "step" })).toHaveTextContent("Connections");
    expect(onStepChange).toHaveBeenLastCalledWith(1);

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(visibleStep()).toBe("customer");
    expect(screen.getByRole("heading", { name: "Customer" })).toHaveFocus();
    // What was typed is kept (steps stay mounted).
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Ramesh");

    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(visibleStep()).toBe("check");
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("type", "submit");
    expect(onStepChange.mock.calls.map(([step]) => step)).toEqual([1, 0, 1, 2]);
    expect(await axeViolations()).toEqual([]);
  });

  it("stays on the step while a required field is empty", async () => {
    render(<Stepper steps={STEPS} {...LABELS} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(visibleStep()).toBe("customer");
    expect(screen.getByRole("textbox", { name: "Name" })).toBeInvalid();
  });

  it("stays on the step when onNext returns false", async () => {
    const onNext = vi.fn(async (step: number) => step !== 1);
    render(<Stepper steps={STEPS} defaultStep={1} onNext={onNext} {...LABELS} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(onNext).toHaveBeenCalledWith(1);
    expect(visibleStep()).toBe("connections");
  });

  it("controlled: follows the `step` prop", async () => {
    const { rerender } = render(<Stepper steps={STEPS} step={0} {...LABELS} />);
    expect(visibleStep()).toBe("customer");
    rerender(<Stepper steps={STEPS} step={2} {...LABELS} />);
    expect(visibleStep()).toBe("check");
  });

  it("the last button submits the surrounding form with every step's fields", async () => {
    const onSubmit = vi.fn((event: SubmitEvent) => {
      event.preventDefault();
      return new FormData(event.target as HTMLFormElement);
    });
    render(
      <form onSubmit={(event) => onSubmit(event.nativeEvent as SubmitEvent)}>
        <Stepper steps={STEPS} {...LABELS} />
      </form>,
    );
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Ramesh");
    await user.click(screen.getByRole("button", { name: "Next" }));
    // Next never submits the form.
    expect(onSubmit).not.toHaveBeenCalled();
    await user.type(screen.getByRole("textbox", { name: "VC number" }), "12345");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledOnce();
    const data = onSubmit.mock.results[0]?.value as FormData;
    expect(Object.fromEntries(data)).toEqual({ name: "Ramesh", vc: "12345" });
  });

  it("finishType=button calls onFinish and shows the busy word meanwhile", async () => {
    let resolve: () => void = () => {};
    const onFinish = vi.fn(() => new Promise<void>((done) => (resolve = done)));
    render(
      <Stepper
        steps={STEPS}
        defaultStep={2}
        finishType="button"
        onFinish={onFinish}
        finishingLabel="Saving…"
        {...LABELS}
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));
    expect(onFinish).toHaveBeenCalledOnce();
    const busy = await screen.findByRole("button", { name: "Saving…" });
    expect(busy).toBeDisabled();
    resolve();
    expect(await screen.findByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("counts fields per step (radio groups once) and warns above 6 in development", () => {
    const container = document.createElement("div");
    container.innerHTML = `
      <input name="a"><input type="hidden" name="h"><select name="s"></select><textarea></textarea>
      <input type="radio" name="m" value="1"><input type="radio" name="m" value="2">
      <input type="submit">`;
    expect(countStepFields(container)).toBe(4);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const crowded = Array.from({ length: STEPPER_MAX_FIELDS + 1 }, (_, index) => (
      <Input key={index} aria-label={`F${index}`} />
    ));
    render(
      <Stepper
        steps={[
          {
            id: "pay",
            title: "Pay",
            content: (
              <RadioCards
                aria-label="Method"
                options={[
                  { value: "cash", label: "Cash" },
                  { value: "upi", label: "UPI" },
                ]}
              />
            ),
          },
          { id: "crowded", title: "Crowded", content: crowded },
        ]}
        {...LABELS}
      />,
    );
    // The RadioCards step has one field: no warning.
    expect(warn).not.toHaveBeenCalled();
    expect(countStepFields(document.querySelector('[data-step="pay"]') as Element)).toBe(1);
    render(<Stepper steps={[{ id: "crowded", title: "Crowded", content: crowded }]} {...LABELS} />);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"crowded" has 7 fields'));
    warn.mockRestore();
  });
});
