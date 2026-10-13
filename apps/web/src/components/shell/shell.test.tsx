import { act, fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CanFn, toNavLinks, visibleChildren, visibleSections } from "@/lib/nav";
import { renderWithIntl } from "@/test/intl";
import en from "../../../messages/en.json";
import { roleCan } from "./access";
import { BottomNav } from "./bottom-nav";
import { SectionMenu } from "./section-menu";
import { SetupChecklist, setupStepsFor } from "./setup-checklist";
import { ShellHeader } from "./shell-header";
import { ShellPageHeader } from "./shell-page-header";
import { SideNav } from "./side-nav";
import { bannerFor, SubscriptionBanner } from "./subscription-banner";

const navigation = vi.hoisted(() => ({ pathname: "/home" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));

const label = (id: keyof typeof en.shell.routes) => en.shell.routes[id];
const sectionLinks = (can: CanFn) => toNavLinks(visibleSections(can), label);
const noop = vi.fn();

beforeEach(() => {
  navigation.pathname = "/home";
});

describe("SideNav", () => {
  it.each(["owner", "staff"] as const)("shows the 7 sections to the %s, icon + word", (role) => {
    renderWithIntl(<SideNav links={sectionLinks(roleCan(role))} label="Main menu" />);
    const nav = screen.getByRole("navigation", { name: "Main menu" });
    const names = within(nav)
      .getAllByRole("link")
      .map((link) => link.textContent);
    expect(names).toEqual([
      "Home",
      "Customers",
      "Payments",
      "Linemen",
      "Bills",
      "Reports",
      "Settings",
    ]);
    for (const link of within(nav).getAllByRole("link")) {
      expect(link.querySelector("svg[data-icon]")).not.toBeNull();
    }
  });

  it("marks the current section (also on its sub-pages)", () => {
    navigation.pathname = "/customers/123/bills";
    renderWithIntl(<SideNav links={sectionLinks(roleCan("owner"))} label="Main menu" />);
    expect(screen.getByRole("link", { name: "Customers" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
  });
});

describe("BottomNav (phones)", () => {
  const renderBar = () =>
    renderWithIntl(
      <BottomNav
        links={sectionLinks(roleCan("owner"))}
        label="Main menu"
        moreLabel="More"
        moreMenuLabel="More pages"
      />,
    );

  it("shows three sections and More; More opens the rest and Escape closes it", () => {
    renderBar();
    const nav = screen.getByRole("navigation", { name: "Main menu" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Home", "Customers", "Payments"]);
    const more = screen.getByRole("button", { name: "More" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByRole("list", { name: "More pages" });
    expect(
      within(list)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Linemen", "Bills", "Reports", "Settings"]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("list", { name: "More pages" })).toBeNull();
    expect(more).toHaveFocus();
  });

  it("closes More when a tap lands outside it", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("list", { name: "More pages" })).toBeNull();
  });

  it("highlights More when the current page is one of its sections", () => {
    navigation.pathname = "/settings/team";
    renderBar();
    expect(screen.getByRole("button", { name: "More" })).toHaveAttribute("data-active", "true");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  });
});

describe("section menus per role", () => {
  const settingsNames = (can: CanFn) => {
    renderWithIntl(
      <SectionMenu
        links={toNavLinks(visibleChildren("settings", can), label)}
        label="Pages in Settings"
      />,
    );
    const names = screen.getAllByRole("link").map((link) => link.textContent);
    return names;
  };

  it("Owner sees every Settings page", () => {
    expect(settingsNames(roleCan("owner"))).toEqual([
      "Business details",
      "Areas",
      "Plans",
      "Staff and linemen",
      "App subscription",
      "Who changed what",
    ]);
  });

  it("Staff never see Team, Subscription or Audit", () => {
    expect(settingsNames(roleCan("staff"))).toEqual(["Business details", "Areas", "Plans"]);
  });

  it("Staff never see the data download in Reports; the Owner does", () => {
    renderWithIntl(
      <SectionMenu
        links={toNavLinks(visibleChildren("reports", roleCan("staff")), label)}
        label="Staff reports"
      />,
    );
    renderWithIntl(
      <SectionMenu
        links={toNavLinks(visibleChildren("reports", roleCan("owner")), label)}
        label="Owner reports"
      />,
    );
    const staff = screen.getByRole("navigation", { name: "Staff reports" });
    const owner = screen.getByRole("navigation", { name: "Owner reports" });
    expect(within(staff).queryByRole("link", { name: "Download data" })).toBeNull();
    expect(within(owner).getByRole("link", { name: "Download data" })).toHaveAttribute(
      "href",
      "/reports/export",
    );
  });

  it("renders nothing without pages", () => {
    const { container } = renderWithIntl(<SectionMenu links={[]} label="Empty" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ShellHeader", () => {
  it("shows the business name, the language switch and the account menu", () => {
    renderWithIntl(
      <ShellHeader
        operatorName="Sharma Cable Network"
        userName="Ramesh Sharma"
        userRole="owner"
        locale="en"
        setLocale={noop}
        signOutAction={noop}
        signOutEverywhereAction={noop}
      />,
    );
    expect(screen.getByText("Sharma Cable Network")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "हिंदी" })).toBeInTheDocument();
    const account = screen.getByRole("button", { name: "Account" });
    fireEvent.click(account);
    expect(screen.getByText("Ramesh Sharma")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toHaveAttribute("type", "submit");
    expect(screen.getByRole("button", { name: "Sign out on all devices" })).toHaveAttribute(
      "type",
      "submit",
    );
  });

  it("speaks Hindi", () => {
    renderWithIntl(
      <ShellHeader
        operatorName="शर्मा केबल"
        userName="सुनीता"
        userRole="staff"
        locale="hi"
        setLocale={noop}
        signOutAction={noop}
        signOutEverywhereAction={noop}
      />,
      "hi",
    );
    fireEvent.click(screen.getByRole("button", { name: "अकाउंट" }));
    expect(screen.getByText("स्टाफ़")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "लॉग आउट करें" })).toBeInTheDocument();
  });
});

describe("SubscriptionBanner (banner slot)", () => {
  const graceEndsAt = new Date("2026-10-20T20:00:00Z"); // 21 Oct in IST

  it("grace: the Owner gets the date (IST) and Pay now", () => {
    renderWithIntl(
      <SubscriptionBanner banner={bannerFor({ status: "grace", graceEndsAt }, true)} locale="en" />,
    );
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("Pay for the app by 21 Oct 2026.");
    expect(within(banner).getByRole("link", { name: "Pay now" })).toHaveAttribute(
      "href",
      "/settings/subscription",
    );
  });

  it("read-only: Staff are told to ask the owner, with no pay button", () => {
    renderWithIntl(
      <SubscriptionBanner
        banner={bannerFor({ status: "read_only", graceEndsAt: null }, false)}
        locale="en"
      />,
    );
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("View only. You can still collect money.");
    expect(banner).toHaveTextContent("Ask the owner to pay for the app.");
    expect(within(banner).queryByRole("link")).toBeNull();
  });

  it("Hindi, and nothing at all when the subscription is fine", () => {
    renderWithIntl(
      <SubscriptionBanner banner={bannerFor({ status: "grace", graceEndsAt }, true)} locale="hi" />,
      "hi",
    );
    expect(screen.getByRole("status")).toHaveTextContent("21 अक्टू 2026 तक ऐप का पेमेंट करें।");
    const { container } = renderWithIntl(
      <SubscriptionBanner
        banner={bannerFor({ status: "active", graceEndsAt: null }, true)}
        locale="en"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("SetupChecklist", () => {
  it("lists the Owner's 4 steps with numbers, progress and one button each", () => {
    renderWithIntl(<SetupChecklist steps={setupStepsFor(roleCan("owner"), { plans: true })} />);
    const card = screen.getByRole("region", { name: "Get started" });
    expect(card).toHaveTextContent("1 of 4 done");
    const items = within(card).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent("Done");
    expect(within(card).getByRole("link", { name: "Add customers" })).toHaveAttribute(
      "href",
      "/customers/new",
    );
    expect(within(card).getByRole("link", { name: "Add linemen" })).toHaveAttribute(
      "href",
      "/settings/team",
    );
  });

  it("disappears when every step is done, and shows Staff only their step", () => {
    const { container } = renderWithIntl(
      <SetupChecklist
        steps={setupStepsFor(roleCan("owner"), {
          plans: true,
          customers: true,
          linemen: true,
          app: true,
        })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    renderWithIntl(<SetupChecklist steps={setupStepsFor(roleCan("staff"))} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "Add plans" })).toBeNull();
  });
});

describe("dismissing on navigation", () => {
  it("closes More when the page changes", () => {
    const view = renderWithIntl(
      <BottomNav
        links={sectionLinks(roleCan("owner"))}
        label="Main menu"
        moreLabel="More"
        moreMenuLabel="More pages"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("list", { name: "More pages" })).toBeInTheDocument();
    navigation.pathname = "/bills";
    act(() => {
      view.rerender(
        <BottomNav
          links={sectionLinks(roleCan("owner"))}
          label="Main menu"
          moreLabel="More"
          moreMenuLabel="More pages"
        />,
      );
    });
    expect(screen.queryByRole("list", { name: "More pages" })).toBeNull();
  });
});

describe("ShellPageHeader", () => {
  it("lifts PageHeader's pinned phone action above the bottom bar", () => {
    renderWithIntl(
      <ShellPageHeader title="Customers" action={<button type="button">Add</button>} />,
    );
    const action = screen.getByRole("button", { name: "Add" }).parentElement;
    expect(action).toHaveAttribute("data-slot", "page-action");
    expect(action?.className).toContain("bottom-16");
    expect(action?.className).not.toMatch(/(^|\s)bottom-0(\s|$)/);
    expect(action?.className).toContain("sm:static");
  });
});
