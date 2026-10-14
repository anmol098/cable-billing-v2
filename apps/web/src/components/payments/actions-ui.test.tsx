import { ToastProvider } from "@cb/ui";
import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/test/intl";
import { ReceiptActions } from "./receipt-actions";
import { ResolveReview } from "./resolve-review";
import type { ReceiptLinkResult, ResolveResult, UndoResult } from "./results";
import { UndoPayment } from "./undo-payment";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

function withToasts(ui: React.ReactElement, locale: "en" | "hi" = "en") {
  return renderWithIntl(
    <ToastProvider closeLabel="Close" label="Notifications">
      {ui}
    </ToastProvider>,
    locale,
  );
}

beforeEach(() => {
  router.refresh.mockClear();
  router.push.mockClear();
});

describe("ReceiptActions", () => {
  it("prints the A5 receipt in a new tab and copies a receipt link (says 'copied', never 'sent')", async () => {
    const copyLink = vi.fn(
      async (): Promise<ReceiptLinkResult> => ({ ok: true, url: "https://cb.test/r/tok" }),
    );
    const writeClipboard = vi.fn(async () => {});
    withToasts(
      <ReceiptActions paymentId="p-1" copyLink={copyLink} writeClipboard={writeClipboard} />,
    );
    const print = screen.getByRole("link", { name: "Print receipt (A5)" });
    expect(print).toHaveAttribute("href", "/payments/p-1/receipt");
    expect(print).toHaveAttribute("target", "_blank");

    fireEvent.click(screen.getByRole("button", { name: "Copy receipt link" }));
    expect(
      await screen.findByText("Link copied. Paste it in WhatsApp or SMS."),
    ).toBeInTheDocument();
    expect(copyLink).toHaveBeenCalledWith("p-1");
    expect(writeClipboard).toHaveBeenCalledWith("https://cb.test/r/tok");
    expect(screen.getByTestId("receipt-link")).toHaveValue("https://cb.test/r/tok");
    expect(document.body.textContent).not.toMatch(/\bsent\b|delivered/i);
  });

  it("without a clipboard the link is shown to copy by hand; errors in words", async () => {
    const copyLink = vi
      .fn<(id: string) => Promise<ReceiptLinkResult>>()
      .mockResolvedValueOnce({ ok: true, url: "https://cb.test/r/tok" })
      .mockResolvedValueOnce({ ok: false, error: "too_many_links" });
    withToasts(
      <ReceiptActions
        paymentId="p-1"
        copyLink={copyLink}
        writeClipboard={async () => {
          throw new Error("denied");
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy receipt link" }));
    expect(await screen.findByLabelText("Copy this link:")).toHaveValue("https://cb.test/r/tok");
    fireEvent.click(screen.getByRole("button", { name: "Copy receipt link" }));
    expect(
      await screen.findByText("This receipt has too many links. Ask the owner to switch some off."),
    ).toBeInTheDocument();
  });
});

describe("UndoPayment", () => {
  function setup(undo = vi.fn(async (): Promise<UndoResult> => ({ ok: true })), locale?: "hi") {
    withToasts(
      <UndoPayment
        paymentId="p-1"
        amount="₹500"
        customerName="Asha Devi"
        balanceAfter="₹500 due"
        undo={undo}
      />,
      locale,
    );
    return undo;
  }

  it("needs a reason, then confirms with the effect and cancels once", async () => {
    const undo = setup();
    fireEvent.click(screen.getByRole("button", { name: "Undo payment" }));
    expect(screen.getByText("Choose a reason.")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Wrong amount" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), {
      target: { value: "typed 5000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Undo payment" }));
    const sheet = await screen.findByRole("alertdialog", { name: "Cancel this payment?" });
    expect(sheet).toHaveTextContent(
      "₹500 from Asha Devi will not count any more. Balance after: ₹500 due.",
    );
    fireEvent.click(within(sheet).getByRole("button", { name: "Undo payment" }));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/payments/p-1?undone=1"));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledWith({
      paymentId: "p-1",
      reason: "wrong_amount",
      note: "typed 5000",
    });
  });

  it("'Other reason' needs a note", () => {
    const undo = setup();
    fireEvent.click(screen.getByRole("radio", { name: "Other reason" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo payment" }));
    expect(screen.getByText("Write a short reason.")).toBeInTheDocument();
    expect(undo).not.toHaveBeenCalled();
  });

  it("refused by the server (not the owner / already cancelled): says so in words", async () => {
    setup(vi.fn(async (): Promise<UndoResult> => ({ ok: false, error: "forbidden" })));
    fireEvent.click(screen.getByRole("radio", { name: "Saved twice" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo payment" }));
    const sheet = await screen.findByRole("alertdialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "Undo payment" }));
    expect(await screen.findByText("Only the owner can undo a payment.")).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("Hindi", () => {
    setup(undefined, "hi");
    expect(screen.getByText("क्यों रद्द कर रहे हैं?")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "गलत रकम" })).toBeInTheDocument();
  });
});

describe("ResolveReview", () => {
  it("marks a payment as checked with an optional note", async () => {
    const resolve = vi.fn(async (): Promise<ResolveResult> => ({ ok: true }));
    withToasts(
      <ResolveReview paymentId="p-1" amount="₹150" customerName="Asha Devi" resolve={resolve} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark as checked" }));
    const dialog = await screen.findByRole("dialog", { name: "Mark this payment as checked?" });
    expect(dialog).toHaveTextContent("₹150 from Asha Devi. The money stays as it is.");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Note (optional)" }), {
      target: { value: " spoke to Ravi " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Mark as checked" }));
    expect(await screen.findByText("Marked as checked")).toBeInTheDocument();
    expect(resolve).toHaveBeenCalledWith({ paymentId: "p-1", note: "spoke to Ravi" });
    expect(router.refresh).toHaveBeenCalled();
  });

  it("someone else checked it first: says so and reloads", async () => {
    withToasts(
      <ResolveReview
        paymentId="p-1"
        amount="₹150"
        customerName="Asha Devi"
        resolve={async () => ({ ok: false, error: "already_resolved" })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark as checked" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Mark as checked" }));
    expect(await screen.findByText("Someone already checked this payment.")).toBeInTheDocument();
    expect(router.refresh).toHaveBeenCalled();
  });
});
