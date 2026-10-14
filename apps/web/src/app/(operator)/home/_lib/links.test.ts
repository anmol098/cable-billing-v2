import { describe, expect, it } from "vitest";
import { roleCan } from "@/components/shell/access";
import { HOME_LINK_IDS, homeLinks } from "./links";
import { busyView, newView } from "./test-fixtures";

describe("homeLinks", () => {
  it("sends every tile and alert to the page with the same number", () => {
    expect(homeLinks(busyView(), roleCan("owner"))).toEqual({
      cash_today: "/payments?method=cash",
      upi_today: "/payments?method=upi",
      collected: "/payments?from=2026-10-01&to=2026-10-14",
      billed: "/bills/register?month=2026-10-01",
      due: "/reports/dues",
      run: "/bills/runs?month=2026-10-01",
      handovers: "/linemen?date=2026-10-12",
      payments_to_check: "/payments/review",
      missed: "/bills/runs?month=2026-07-01&preview=1",
      subscription: "/settings/subscription",
    });
  });

  it("before any bill run or alert: the Bills page and today's Linemen page", () => {
    const links = homeLinks(newView(), roleCan("owner"));
    expect(links.run).toBe("/bills");
    expect(links.missed).toBe("/bills");
    expect(links.handovers).toBe("/linemen");
  });

  it("Staff: everything but the Owner's subscription page", () => {
    const links = homeLinks(busyView(), roleCan("staff"));
    expect(links.subscription).toBeNull();
    expect(HOME_LINK_IDS.filter((id) => links[id] === null)).toEqual(["subscription"]);
  });

  it("no link to a page the role may not open", () => {
    const links = homeLinks(busyView(), (capability) => capability !== "reports.view");
    expect(links.due).toBeNull();
    expect(links.cash_today).not.toBeNull();
    const none = homeLinks(busyView(), roleCan("lineman"));
    expect(HOME_LINK_IDS.every((id) => none[id] === null)).toBe(true);
  });
});
