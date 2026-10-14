import { ToastProvider } from "@cb/ui";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/test/intl";
import { CounterPayment } from "./counter-payment";
import type {
  FindCustomersResult,
  PickerCustomer,
  ReceiptLinkResult,
  TakePaymentInput,
  TakePaymentResult,
} from "./results";

beforeAll(() => {
  // Radix Popover (the customer picker) measures with ResizeObserver; jsdom has none.
  if (!("ResizeObserver" in globalThis)) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

const ASHA: PickerCustomer = {
  id: "0199d0c4-0000-7000-8000-000000000001",
  code: "1045",
  name: "Asha Devi",
  phone: "9876543210",
  areaName: "Ward 3",
  balancePaise: 45_000,
  active: true,
};

const saved = (input: TakePaymentInput, outcome: "posted" | "duplicate" = "posted") =>
  ({
    ok: true,
    payment: {
      paymentId: input.id,
      outcome,
      receiptNumber: "R-2610-00012",
      amountPaise: input.amountPaise,
      method: input.method,
      newBalancePaise: 45_000 - input.amountPaise,
      reviewReason: null,
      cancelled: false,
    },
  }) as const satisfies TakePaymentResult;

function setup(
  options: {
    initial?: PickerCustomer | null;
    takePayment?: (input: TakePaymentInput) => Promise<TakePaymentResult>;
    ids?: string[];
    locale?: "en" | "hi";
  } = {},
) {
  const findCustomers = vi.fn(
    async (): Promise<FindCustomersResult> => ({ ok: true, customers: [ASHA] }),
  );
  const takePayment = vi.fn(options.takePayment ?? (async (input) => saved(input)));
  const copyReceiptLink = vi.fn(
    async (): Promise<ReceiptLinkResult> => ({ ok: true, url: "https://r.test/r/abc" }),
  );
  const ids = [...(options.ids ?? ["id-1", "id-2", "id-3"])];
  const makeId = vi.fn(() => ids.shift() ?? "id-x");
  renderWithIntl(
    <ToastProvider closeLabel="Close" label="Notifications">
      <CounterPayment
        initialCustomer={options.initial ?? null}
        findCustomers={findCustomers}
        takePayment={takePayment}
        copyReceiptLink={copyReceiptLink}
        makeId={makeId}
      />
    </ToastProvider>,
    options.locale ?? "en",
  );
  return { findCustomers, takePayment, copyReceiptLink, makeId };
}

async function pickAsha() {
  const box = screen.getByRole("combobox", { name: "Find customer" });
  fireEvent.change(box, { target: { value: "asha" } });
  fireEvent.click(await screen.findByRole("option", { name: /Asha Devi/ }));
}

const amountBox = () => screen.getByRole("textbox", { name: "Amount (₹)" });

describe("CounterPayment (T-048)", () => {
  it("four taps: customer → amount pre-filled with the due → Cash → Save", async () => {
    const { takePayment, findCustomers } = setup();
    expect(screen.getByText("Step 1 of 4")).toBeInTheDocument();
    await pickAsha();
    expect(findCustomers).toHaveBeenCalledWith("asha");

    // Step 2: the due is shown and is the amount already.
    expect(screen.getByText("Step 2 of 4")).toBeInTheDocument();
    expect(screen.getByTestId("due-now")).toHaveTextContent("₹450");
    expect(amountBox()).toHaveValue("450");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    // Step 3: Cash goes straight to the check screen.
    expect(screen.getByRole("heading", { name: "How did they pay?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cash" }));

    // Step 4: the summary with the numbers, then Save.
    expect(screen.getByText("Step 4 of 4")).toBeInTheDocument();
    expect(screen.getByTestId("confirm-summary")).toHaveTextContent("₹450 Cash from Asha Devi");
    expect(screen.getByText("After this: Nothing due")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("save-payment"));

    expect(await screen.findByRole("heading", { name: "Money saved" })).toBeInTheDocument();
    expect(takePayment).toHaveBeenCalledTimes(1);
    expect(takePayment).toHaveBeenCalledWith({
      id: "id-1",
      customerId: ASHA.id,
      amountPaise: 45_000,
      method: "cash",
    });
    expect(screen.getByTestId("saved-receipt")).toHaveTextContent("R-2610-00012");
    expect(screen.getByTestId("saved-balance")).toHaveTextContent("Nothing due");
    expect(screen.getByRole("link", { name: "Print receipt (A5)" })).toHaveAttribute(
      "href",
      "/payments/id-1/receipt",
    );
    // Honest words only: nothing says the receipt was sent.
    expect(document.body.textContent).not.toMatch(/\bsent\b|delivered/i);
  });

  it("a double click on Save saves once, with one payment id", async () => {
    let finish: (value: TakePaymentResult) => void = () => {};
    const { takePayment, makeId } = setup({
      initial: ASHA,
      takePayment: (input) =>
        new Promise((resolve) => {
          finish = () => resolve(saved(input));
        }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Cash" }));
    const save = screen.getByTestId("save-payment");
    fireEvent.click(save);
    fireEvent.click(save);
    fireEvent.click(save);
    expect(takePayment).toHaveBeenCalledTimes(1);
    finish(saved({ id: "id-1", customerId: ASHA.id, amountPaise: 45_000, method: "cash" }));
    expect(await screen.findByRole("heading", { name: "Money saved" })).toBeInTheDocument();
    expect(makeId).toHaveBeenCalledTimes(1);
  });

  it("a retry after 'Could not save' sends the same payment id (never two payments)", async () => {
    const answers: TakePaymentResult[] = [{ ok: false, error: "generic" }];
    const { takePayment } = setup({
      initial: ASHA,
      takePayment: async (input) => answers.shift() ?? saved(input, "duplicate"),
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Cash" }));
    fireEvent.click(screen.getByTestId("save-payment"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save. Try again. If you saved it already, it will not be saved twice.",
    );
    // Back to change nothing and save again: the same id goes to the server.
    fireEvent.click(screen.getByTestId("save-payment"));
    expect(await screen.findByRole("heading", { name: "Money saved" })).toBeInTheDocument();
    expect(takePayment).toHaveBeenCalledTimes(2);
    expect(takePayment.mock.calls.map(([input]) => input.id)).toEqual(["id-1", "id-1"]);
  });

  it("'Take another payment' starts a new form with a new payment id", async () => {
    const { takePayment } = setup({ initial: ASHA });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Cash" }));
    fireEvent.click(screen.getByTestId("save-payment"));
    fireEvent.click(await screen.findByRole("button", { name: "Take another payment" }));
    expect(screen.getByText("Step 1 of 4")).toBeInTheDocument();
    await pickAsha();
    fireEvent.change(amountBox(), { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Cash" }));
    fireEvent.click(screen.getByTestId("save-payment"));
    await screen.findByRole("heading", { name: "Money saved" });
    expect(takePayment.mock.calls.map(([input]) => [input.id, input.amountPaise])).toEqual([
      ["id-1", 45_000],
      ["id-2", 20_000],
    ]);
  });

  it("UPI: optional ref no., sent trimmed; the amount must be typed; whole rupees only", async () => {
    const { takePayment } = setup({ initial: { ...ASHA, balancePaise: 0 } });
    expect(screen.getByText("Nothing due now")).toBeInTheDocument();
    expect(amountBox()).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Type the amount.")).toBeInTheDocument();
    fireEvent.change(amountBox(), { target: { value: "12.50" } });
    expect(screen.getByText("Whole rupees only.")).toBeInTheDocument();
    fireEvent.change(amountBox(), { target: { value: "300" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "UPI" }));
    fireEvent.change(screen.getByRole("textbox", { name: "UPI ref no. (if you have it)" }), {
      target: { value: " 412345678901 " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByTestId("confirm-summary")).toHaveTextContent("₹300 UPI from Asha Devi");
    fireEvent.click(screen.getByTestId("save-payment"));
    await screen.findByRole("heading", { name: "Money saved" });
    expect(takePayment).toHaveBeenCalledWith({
      id: "id-1",
      customerId: ASHA.id,
      amountPaise: 30_000,
      method: "upi",
      upiReference: "412345678901",
    });
  });

  it("an id already saved with other details points to that payment", async () => {
    setup({
      initial: ASHA,
      takePayment: async () => ({ ok: false, error: "already_saved_different" }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Cash" }));
    fireEvent.click(screen.getByTestId("save-payment"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("already saved with other details");
    expect(within(alert).getByRole("link", { name: "Open payment" })).toHaveAttribute(
      "href",
      "/payments/id-1",
    );
  });

  it("works in Hindi", async () => {
    setup({ initial: ASHA, locale: "hi" });
    expect(screen.getByRole("heading", { name: "कितने पैसे?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "आगे" }));
    fireEvent.click(screen.getByRole("button", { name: "नकद" }));
    expect(screen.getByTestId("confirm-summary")).toHaveTextContent("Asha Devi से ₹450 नकद");
    fireEvent.click(screen.getByTestId("save-payment"));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "पैसे सेव हो गए" })).toBeInTheDocument(),
    );
  });
});
