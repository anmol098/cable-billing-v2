import { ToastProvider } from "@cb/ui";
import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/test/intl";
import { RunActions, type RunActionsProps } from "./run-actions";
import type { RunActionResult } from "./run-result";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const started = async (): Promise<RunActionResult> => ({ ok: true, outcome: "started" });

function setup(props: Partial<RunActionsProps> = {}, locale: "en" | "hi" = "en") {
  const start = vi.fn(started);
  const retry = vi.fn(started);
  const view = renderWithIntl(
    <ToastProvider closeLabel="Close" label="Notifications">
      <RunActions
        period="2026-11-01"
        monthLabel="November 2026"
        canStart
        retryRunId={null}
        failedCount={0}
        preview={null}
        start={start}
        retry={retry}
        {...props}
      />
    </ToastProvider>,
    locale,
  );
  return { start, retry, view };
}

describe("RunActions", () => {
  beforeEach(() => router.refresh.mockClear());

  it("Make bills now asks once, then starts the month's run", async () => {
    const { start } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Make bills now" }));
    const sheet = await screen.findByRole("alertdialog", { name: "Make bills for November 2026?" });
    expect(sheet).toHaveTextContent(
      "Every customer who has no bill for November 2026 gets one now. Nobody gets a second bill.",
    );
    fireEvent.click(within(sheet).getByRole("button", { name: "Make bills" }));
    await vi.waitFor(() => expect(start).toHaveBeenCalledWith({ period: "2026-11-01" }));
    expect(await screen.findByText("Making bills now")).toBeInTheDocument();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("states the preview's numbers when the preview is open", async () => {
    setup({ preview: { count: 128, amount: "57,600" } });
    fireEvent.click(screen.getByRole("button", { name: "Make bills now" }));
    const sheet = await screen.findByRole("alertdialog");
    expect(sheet).toHaveTextContent("128 customers get a bill, total ₹57,600.");
  });

  it("Try problems again retries the run's failed customers", async () => {
    const { retry } = setup({ canStart: false, retryRunId: "run-1", failedCount: 2 });
    expect(screen.queryByRole("button", { name: "Make bills now" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try problems again" }));
    const sheet = await screen.findByRole("alertdialog");
    expect(sheet).toHaveTextContent("2 customers are tried again.");
    fireEvent.click(within(sheet).getByRole("button", { name: "Try again" }));
    await vi.waitFor(() => expect(retry).toHaveBeenCalledWith({ runId: "run-1" }));
    expect(await screen.findByText("Trying again now")).toBeInTheDocument();
  });

  it("says when the server refuses (Staff, view-only)", async () => {
    const start = vi.fn(async (): Promise<RunActionResult> => ({ ok: false, error: "forbidden" }));
    setup({ start });
    fireEvent.click(screen.getByRole("button", { name: "Make bills now" }));
    const sheet = await screen.findByRole("alertdialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "Make bills" }));
    expect(await screen.findByText("Only the owner can make bills.")).toBeInTheDocument();
  });

  it("renders nothing when neither action is allowed", () => {
    const { view } = setup({ canStart: false, retryRunId: null });
    expect(view.container.querySelector("button")).toBeNull();
  });

  it("speaks Hindi", () => {
    setup({ retryRunId: "run-1", failedCount: 1 }, "hi");
    expect(screen.getByRole("button", { name: "अभी बिल बनाएँ" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "दिक्कत वाले फिर से करें" })).toBeInTheDocument();
  });
});
