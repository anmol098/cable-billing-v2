import { ToastProvider } from "@cb/ui";
import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/test/intl";
import type { ReviewActionResult } from "../_lib/review-result";
import { ReviewActions } from "./review-actions";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const IDS = { sessionId: "s-1", submissionId: "sub-1" };

function setup(
  accept = vi.fn(async (): Promise<ReviewActionResult> => ({ ok: true, status: "accepted" })),
  sendBack = vi.fn(async (): Promise<ReviewActionResult> => ({ ok: true, status: "returned" })),
  locale: "en" | "hi" = "en",
) {
  renderWithIntl(
    <ToastProvider closeLabel="Close" label="Notifications">
      <ReviewActions
        {...IDS}
        linemanName="Ravi"
        handed="₹750"
        expected="₹800"
        difference="₹50 short"
        accept={accept}
        sendBack={sendBack}
      />
    </ToastProvider>,
    locale,
  );
  return { accept, sendBack };
}

describe("ReviewActions", () => {
  beforeEach(() => router.refresh.mockClear());

  it("Accept asks once with the numbers, then accepts this submission", async () => {
    const { accept } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    const sheet = await screen.findByRole("alertdialog", { name: "Accept this cash?" });
    expect(sheet).toHaveTextContent("Ravi gave ₹750. Expected ₹800. ₹50 short.");
    fireEvent.click(within(sheet).getByRole("button", { name: "Accept" }));
    await vi.waitFor(() => expect(accept).toHaveBeenCalledWith(IDS));
    expect(await screen.findByText("Cash accepted")).toBeInTheDocument();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("a stale handover (already accepted elsewhere) says so and reloads", async () => {
    setup(vi.fn(async () => ({ ok: false, error: "already_accepted" }) as const));
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    const sheet = await screen.findByRole("alertdialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "Accept" }));
    expect(await screen.findByText("This handover was already accepted.")).toBeInTheDocument();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("Send back needs a note, then sends it", async () => {
    const { sendBack } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Send back" }));
    const dialog = await screen.findByRole("dialog", { name: "Send this handover back?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send back" }));
    expect(within(dialog).getByText("Write what the lineman should fix.")).toBeInTheDocument();
    expect(sendBack).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText("What should the lineman fix?"), {
      target: { value: "  Count the notes again " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send back" }));
    await vi.waitFor(() =>
      expect(sendBack).toHaveBeenCalledWith({ ...IDS, note: "Count the notes again" }),
    );
    expect(await screen.findByText("Sent back to the lineman")).toBeInTheDocument();
  });

  it("Hindi words", async () => {
    setup(undefined, undefined, "hi");
    expect(screen.getByRole("button", { name: "मंज़ूर करें" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "वापस भेजें" })).toBeInTheDocument();
  });
});
