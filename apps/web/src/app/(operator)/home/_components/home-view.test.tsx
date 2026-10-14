import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LINEMAN_APP_URL } from "@/app/(operator)/settings/team/share";
import { roleCan } from "@/components/shell/access";
import { renderWithIntl } from "@/test/intl";
import { busyView, newView, runView } from "../_lib/test-fixtures";
import { qrPath } from "./app-qr";
import { HomeView } from "./home-view";

const owner = roleCan("owner");
const staff = roleCan("staff");

describe("HomeView: a busy day", () => {
  it("shows today's cash and UPI apart, each tile opening the register", () => {
    renderWithIntl(<HomeView view={busyView()} can={owner} locale="en" />);
    expect(screen.getByRole("heading", { name: "Today, 14 Oct 2026" })).toBeInTheDocument();
    const cash = screen.getByTestId("home-cash-today");
    expect(cash).toHaveTextContent("Cash today₹1,040");
    expect(cash).toHaveAttribute("href", "/payments?method=cash");
    const upi = screen.getByTestId("home-upi-today");
    expect(upi).toHaveTextContent("UPI today₹150");
    expect(upi).toHaveAttribute("href", "/payments?method=upi");
    expect(screen.getByTestId("home-payments-today")).toHaveTextContent("5 payments");
  });

  it("shows this month: bills made vs money taken, total due in red, the run's state", () => {
    renderWithIntl(<HomeView view={busyView()} can={owner} locale="en" />);
    expect(screen.getByRole("heading", { name: "This month: October 2026" })).toBeInTheDocument();
    const billed = screen.getByTestId("home-billed");
    expect(billed).toHaveTextContent("Bills made₹9003 bills");
    expect(billed).toHaveAttribute("href", "/bills/register?month=2026-10-01");
    const collected = screen.getByTestId("home-collected");
    expect(collected).toHaveTextContent("Money taken₹13,000");
    expect(screen.getByTestId("home-collected-cash")).toHaveTextContent("Cash₹12,345");
    expect(screen.getByTestId("home-collected-upi")).toHaveTextContent("UPI₹655");
    expect(collected).toHaveAttribute("href", "/payments?from=2026-10-01&to=2026-10-14");
    const due = screen.getByTestId("home-due");
    expect(due).toHaveTextContent("Total due₹1102 customers owe money");
    expect(within(due).getByText("₹110").closest("[data-tone]")).toHaveAttribute(
      "data-tone",
      "due",
    );
    expect(due).toHaveAttribute("href", "/reports/dues");
    const run = screen.getByTestId("home-run");
    expect(run).toHaveTextContent("Bills of October 2026Bills made");
    expect(run).toHaveAttribute("href", "/bills/runs?month=2026-10-01");
  });

  it("lists what needs checking, each row opening its page; no checklist once set up", () => {
    renderWithIntl(<HomeView view={busyView()} can={owner} locale="en" />);
    const alerts = screen.getByRole("region", { name: "To check" });
    const rows = within(alerts).getAllByRole("link");
    expect(rows.map((row) => [row.textContent, row.getAttribute("href")])).toEqual([
      ["2 cash handovers to check", "/linemen?date=2026-10-12"],
      ["1 payment to check", "/payments/review"],
      ["Bills of 2 months were missed", "/bills/runs?month=2026-07-01&preview=1"],
    ]);
    expect(screen.queryByRole("region", { name: "Get started" })).toBeNull();
  });

  it("a run with problems or a missed month says so in red", () => {
    renderWithIntl(
      <HomeView
        view={busyView({ latestRun: runView({ status: "completed_with_errors", failedCount: 1 }) })}
        can={owner}
        locale="en"
      />,
    );
    expect(screen.getByTestId("home-run")).toHaveTextContent("Some problems");
    expect(
      within(screen.getByTestId("home-run")).getByText("Some problems").parentElement,
    ).toHaveClass("text-danger");
  });

  it("Hindi", () => {
    renderWithIntl(<HomeView view={busyView()} can={owner} locale="hi" />, "hi");
    expect(screen.getByRole("heading", { name: "आज, 14 अक्टू 2026" })).toBeInTheDocument();
    expect(screen.getByTestId("home-cash-today")).toHaveTextContent("आज नकद₹1,040");
    expect(screen.getByTestId("home-upi-today")).toHaveTextContent("आज UPI₹150");
    expect(screen.getByRole("heading", { name: "इस महीने: अक्टूबर 2026" })).toBeInTheDocument();
    expect(screen.getByTestId("home-due")).toHaveTextContent("कुल बाकी₹1102 ग्राहकों का बाकी है");
    expect(screen.getByTestId("home-run")).toHaveTextContent("अक्टूबर 2026 के बिलबिल बन गए");
    const alerts = screen.getByRole("region", { name: "जाँचना है" });
    expect(
      within(alerts)
        .getAllByRole("link")
        .map((row) => row.textContent),
    ).toEqual(["2 कैश जाँचने बाकी", "1 पेमेंट जाँचना है", "2 महीनों के बिल छूट गए"]);
  });
});

describe("HomeView: a new business", () => {
  it("shows the 4-step checklist with the app's Play Store link and QR code first", () => {
    renderWithIntl(<HomeView view={newView()} can={owner} locale="en" />);
    const checklist = screen.getByRole("region", { name: "Get started" });
    expect(checklist).toHaveTextContent("0 of 4 done");
    expect(within(checklist).getAllByRole("listitem")).toHaveLength(4);
    const app = within(checklist).getByRole("link", { name: "Get the app" });
    expect(app).toHaveAttribute("href", LINEMAN_APP_URL);
    expect(app).toHaveAttribute("target", "_blank");
    expect(app).toHaveAttribute("rel", "noopener noreferrer");
    expect(
      within(checklist).getByRole("img", { name: "QR code: the lineman app on Google Play" }),
    ).toBeInTheDocument();
    expect(checklist).toHaveTextContent("Scan this with the lineman's phone");
    // The checklist comes before the numbers.
    const today = screen.getByRole("heading", { name: "Today, 14 Oct 2026" });
    expect(
      checklist.compareDocumentPosition(today) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("ticks steps from the data; the QR goes once the app is on a phone", () => {
    renderWithIntl(
      <HomeView
        view={newView({ setup: { plans: true, customers: true, linemen: true, app: true } })}
        can={owner}
        locale="en"
      />,
    );
    expect(screen.queryByRole("region", { name: "Get started" })).toBeNull();
    renderWithIntl(
      <HomeView
        view={newView({ setup: { plans: true, customers: false, linemen: true, app: true } })}
        can={owner}
        locale="en"
      />,
    );
    const checklist = screen.getByRole("region", { name: "Get started" });
    expect(checklist).toHaveTextContent("3 of 4 done");
    expect(within(checklist).queryByRole("img")).toBeNull();
  });

  it("zeros, no alerts, the trial for the Owner, and no bill run yet", () => {
    renderWithIntl(<HomeView view={newView()} can={owner} locale="en" />);
    expect(screen.getByTestId("home-cash-today")).toHaveTextContent("₹0");
    expect(screen.getByTestId("home-due")).toHaveTextContent("Total due₹0Nobody owes money");
    expect(screen.getByTestId("home-billed")).toHaveTextContent("No bills yet");
    const run = screen.getByTestId("home-run");
    expect(run).toHaveTextContent("Not made");
    expect(run).toHaveTextContent("Bills are made by themselves on the 1st of every month.");
    expect(run).toHaveAttribute("href", "/bills");
    const alerts = screen.getByRole("region", { name: "To check" });
    const trial = within(alerts).getByRole("link");
    expect(trial).toHaveTextContent("Free trial: 30 days leftFree until 13 Nov 2026.Pay now");
    expect(trial).toHaveAttribute("href", "/settings/subscription");
  });

  it("the trial's last day, and nothing to check", () => {
    renderWithIntl(
      <HomeView
        view={newView({
          subscription: {
            status: "active",
            mode: "normal",
            trialEndsOn: null,
            trialDaysLeft: null,
            graceEndsOn: null,
          },
        })}
        can={owner}
        locale="en"
      />,
    );
    expect(screen.getByText("Nothing to check now.")).toBeInTheDocument();
    renderWithIntl(
      <HomeView
        view={newView({
          subscription: {
            status: "trialing",
            mode: "normal",
            trialEndsOn: newView().today,
            trialDaysLeft: 0,
            graceEndsOn: null,
          },
        })}
        can={owner}
        locale="hi"
      />,
      "hi",
    );
    expect(screen.getByText("फ़्री ट्रायल आज ख़त्म")).toBeInTheDocument();
  });

  it("Staff: only their own step, no trial row (the Owner pays)", () => {
    renderWithIntl(<HomeView view={newView()} can={staff} locale="en" />);
    const checklist = screen.getByRole("region", { name: "Get started" });
    expect(within(checklist).getAllByRole("listitem")).toHaveLength(1);
    expect(within(checklist).queryByRole("img")).toBeNull();
    expect(screen.getByText("Nothing to check now.")).toBeInTheDocument();
  });

  it("Hindi checklist and empty state", () => {
    renderWithIntl(<HomeView view={newView()} can={owner} locale="hi" />, "hi");
    expect(
      screen.getByRole("img", { name: "QR कोड: Google Play पर लाइनमैन ऐप" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("home-due")).toHaveTextContent("किसी का बाकी नहीं");
    expect(screen.getByText("फ़्री ट्रायल: 30 दिन बाकी")).toBeInTheDocument();
  });
});

describe("qrPath", () => {
  it("draws the app link's QR modules with a quiet zone", () => {
    const { d, size } = qrPath(LINEMAN_APP_URL);
    // ≥ version 4 (33 modules) for a 68-character URL at level M, plus 2 + 2 quiet modules.
    expect(size).toBeGreaterThanOrEqual(37);
    // The top-left finder pattern starts right after the quiet zone; the zone itself is empty.
    expect(d).toContain("M2 2h1v1h-1z");
    expect(d).not.toContain("M0 0h1v1h-1z");
    expect(d).not.toContain("M1 1h1v1h-1z");
  });
});
