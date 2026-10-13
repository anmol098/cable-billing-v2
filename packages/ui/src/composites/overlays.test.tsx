// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../primitives/Button";
import { axeViolations } from "../primitives/test-helpers";
import { Combobox, type ComboboxOption } from "./Combobox";
import { ConfirmSheet } from "./ConfirmSheet";
import { Dialog, DialogClose } from "./Dialog";
import { HelpTip } from "./HelpTip";
import { ToastProvider, useToast } from "./Toast";

describe("Dialog", () => {
  it("opens from its trigger, focuses the panel, closes on Escape and returns focus", async () => {
    render(
      <Dialog
        title="Edit plan"
        description="Change the monthly rent."
        closeLabel="Close"
        trigger={<Button>Edit</Button>}
        footer={
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
        }
      >
        <p>Body</p>
      </Dialog>,
    );
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "Edit" });
    await user.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Edit plan" });
    expect(dialog).toHaveAccessibleDescription("Change the monthly rent.");
    expect(dialog).toHaveFocus();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("closes from the close button and from a DialogClose in the footer", async () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog
        title="T"
        closeLabel="Close"
        defaultOpen
        onOpenChange={onOpenChange}
        footer={
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
        }
      />,
    );
    const user = userEvent.setup();
    // No description: the dialog is not described by anything.
    expect(screen.getByRole("dialog")).not.toHaveAttribute("aria-describedby");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("ConfirmSheet", () => {
  it("states the effect, confirms with a busy state, then closes", async () => {
    let finish: () => void = () => {};
    const onConfirm = vi.fn(() => new Promise<void>((done) => (finish = done)));
    render(
      <ConfirmSheet
        title="Stop this connection?"
        summary={
          <p>
            Set-top box 12345 will stop. Rent stops from <strong>November</strong>.
          </p>
        }
        confirmLabel="Stop connection"
        cancelLabel="Cancel"
        confirmIcon="danger"
        tone="danger"
        loadingLabel="Stopping…"
        onConfirm={onConfirm}
        trigger={<Button variant="danger">Stop</Button>}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Stop" }));

    const sheet = screen.getByRole("alertdialog", { name: "Stop this connection?" });
    expect(sheet).toHaveAccessibleDescription(/Rent stops from November/);
    expect(sheet).toHaveFocus();
    const confirm = screen.getByRole("button", { name: "Stop connection" });
    expect(confirm).toHaveClass("bg-danger", "min-h-primary-button");
    expect(await axeViolations()).toEqual([]);

    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    // Escape can't close it while saving.
    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    await act(async () => finish());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("stays open when onConfirm fails, and cancel closes it without confirming", async () => {
    const onConfirm = vi.fn(async () => {
      throw new Error("offline");
    });
    render(
      <ConfirmSheet
        title="Save payment?"
        summary="₹450 cash from Ramesh."
        confirmLabel="Save"
        cancelLabel="Cancel"
        onConfirm={onConfirm}
        defaultOpen
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    // A tap outside does not close an alert dialog.
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});

function ToastDemo() {
  const { toast } = useToast();
  return (
    <>
      <Button onClick={() => toast({ variant: "pending", title: "Saved on phone" })}>Save</Button>
      <Button onClick={() => toast({ variant: "danger", title: "Problem", description: "Retry." })}>
        Fail
      </Button>
    </>
  );
}

describe("Toast", () => {
  it("shows icon + colour + word, and closes from its close button", async () => {
    render(
      <ToastProvider closeLabel="Close" label="Notifications">
        <ToastDemo />
      </ToastProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save" }));

    const title = await screen.findByText("Saved on phone");
    const toast = title.closest("[data-variant]") as HTMLElement;
    expect(toast).toHaveAttribute("data-variant", "pending");
    const icon = toast.querySelector('svg[data-icon="pending"]');
    expect(icon).toHaveClass("text-pending");
    expect(await axeViolations()).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByText("Saved on phone")).toBeNull());
  });

  it("problems stay until closed; others hide after their duration", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(
        <ToastProvider closeLabel="Close" label="Notifications" duration={1000}>
          <ToastDemo />
        </ToastProvider>,
      );
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.click(screen.getByRole("button", { name: "Save" }));
      await user.click(screen.getByRole("button", { name: "Fail" }));
      expect(await screen.findByText("Saved on phone")).toBeInTheDocument();
      expect(screen.getByText("Retry.")).toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.queryByText("Saved on phone")).toBeNull();
      expect(screen.getByText("Problem")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("useToast outside the provider is a programming error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<ToastDemo />)).toThrow(/inside <ToastProvider>/);
    vi.restoreAllMocks();
  });
});

const CUSTOMERS: ComboboxOption[] = [
  { value: "c1", label: "Ramesh Kumar", description: "C-101 · 98765 43210" },
  { value: "c2", label: "Ramesh Singh", description: "C-102" },
  { value: "c3", label: "Sita Devi", description: "C-103" },
];

function search(query: string): Promise<ComboboxOption[]> {
  const q = query.toLowerCase();
  return Promise.resolve(CUSTOMERS.filter((c) => c.label.toLowerCase().includes(q)));
}

const COMBO_LABELS = {
  label: "Find customer",
  loadingLabel: "Searching…",
  emptyLabel: "No customer found",
  errorLabel: "Could not search",
  resultsLabel: (count: number) => `${count} found`,
};

describe("Combobox", () => {
  it("searches as you type, arrows + Enter choose, the field shows the choice", async () => {
    const onSelect = vi.fn();
    const loadOptions = vi.fn(search);
    render(
      <form aria-label="f">
        <Combobox
          {...COMBO_LABELS}
          loadOptions={loadOptions}
          onSelect={onSelect}
          debounceMs={0}
          name="customer_id"
        />
      </form>,
    );
    const user = userEvent.setup();
    const input = screen.getByRole("combobox", { name: "Find customer" });
    expect(input).toHaveAttribute("aria-expanded", "false");

    await user.type(input, "ram");
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Ramesh KumarC-101 · 98765 43210",
      "Ramesh SinghC-102",
    ]);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveFocus();
    expect(loadOptions).toHaveBeenLastCalledWith("ram", expect.any(AbortSignal));
    expect(screen.getByRole("status")).toHaveTextContent("2 found");
    expect(input).toHaveAttribute("aria-activedescendant", options[0]?.id);
    expect(await axeViolations()).toEqual([]);

    await user.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute("aria-activedescendant", options[1]?.id);
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledWith(CUSTOMERS[1]);
    expect(input).toHaveValue("Ramesh Singh");
    expect(input).toHaveAttribute("aria-expanded", "false");
    const form = screen.getByRole("form", { name: "f" }) as HTMLFormElement;
    expect(new FormData(form).get("customer_id")).toBe("c2");
  });

  it("tap to choose; says when nothing matches or the search failed", async () => {
    const onSelect = vi.fn();
    const { unmount } = render(
      <Combobox {...COMBO_LABELS} loadOptions={search} onSelect={onSelect} debounceMs={0} />,
    );
    const user = userEvent.setup();
    const input = screen.getByRole("combobox");
    await user.type(input, "sita");
    await user.click(await screen.findByRole("option", { name: /Sita Devi/ }));
    expect(onSelect).toHaveBeenCalledWith(CUSTOMERS[2]);

    await user.clear(input);
    await user.type(input, "zzz");
    expect(await screen.findByText("No customer found", { selector: "p" })).toBeInTheDocument();
    unmount();

    render(
      <Combobox
        {...COMBO_LABELS}
        loadOptions={() => Promise.reject(new Error("offline"))}
        onSelect={onSelect}
        debounceMs={0}
      />,
    );
    await user.type(screen.getByRole("combobox"), "r");
    expect(await screen.findByText("Could not search", { selector: "p" })).toBeInTheDocument();
  });

  it("waits for a pause in typing and aborts the previous search", async () => {
    const signals: AbortSignal[] = [];
    const loadOptions = vi.fn((query: string, signal: AbortSignal) => {
      signals.push(signal);
      return search(query);
    });
    render(
      <Combobox {...COMBO_LABELS} loadOptions={loadOptions} onSelect={() => {}} debounceMs={300} />,
    );
    // delay: null types every letter in the same tick, so a slow or busy machine cannot stretch
    // the gap between keystrokes past the debounce (it did with 50 ms and per-key delays).
    const user = userEvent.setup({ delay: null });
    await user.type(screen.getByRole("combobox"), "sit");
    await screen.findByRole("option", { name: /Sita Devi/ });
    // Typed quickly: one search for the whole word, not one per letter.
    expect(loadOptions).toHaveBeenCalledTimes(1);
    expect(loadOptions).toHaveBeenCalledWith("sit", expect.any(AbortSignal));
    await user.type(screen.getByRole("combobox"), "a");
    await waitFor(() => expect(loadOptions).toHaveBeenCalledTimes(2));
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe("HelpTip", () => {
  it("opens one sentence and its translation on click, closes on Escape", async () => {
    render(
      <HelpTip
        label="Help: Due"
        text="Money the customer still has to pay."
        translation={{ text: "ग्राहक को अभी जितने पैसे देने हैं।", lang: "hi" }}
      />,
    );
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Help: Due" });
    expect(button).toHaveClass("size-touch-min");
    await user.click(button);

    expect(screen.getByText("Money the customer still has to pay.")).toBeInTheDocument();
    expect(screen.getByText("ग्राहक को अभी जितने पैसे देने हैं।")).toHaveAttribute("lang", "hi");
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(await axeViolations()).toEqual([]);

    await user.keyboard("{Escape}");
    expect(screen.queryByText("Money the customer still has to pay.")).toBeNull();
    expect(button).toHaveFocus();
  });
});
