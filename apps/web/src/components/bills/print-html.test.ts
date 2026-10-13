import { describe, expect, it } from "vitest";
import { BILL_PRINT_CSS, billPrintHtml, escapeHtml } from "./print-html";
import { billsT, billView } from "./test-fixtures";

const NOW = new Date("2026-11-20T06:00:00Z");

describe("printable A5 bill", () => {
  it("is an A5 page with token styles only", () => {
    expect(BILL_PRINT_CSS).toContain("@page{size:A5 portrait;");
    expect(BILL_PRINT_CSS).not.toMatch(/shadow|gradient/);
    // Colours come from tokens.json (no colour written by hand in the module).
    expect(BILL_PRINT_CSS).toContain("#111111");
  });

  it("prints the bill in the operator's language (Hindi), with the lines per VC", () => {
    const html = billPrintHtml(billView(), billsT("hi"), "hi", { autoPrint: false, now: NOW });
    expect(html).toContain('<html lang="hi">');
    expect(html).toContain("<title>बिल INV-2611-00001</title>");
    expect(html).toContain("Sharma Cable");
    expect(html).toContain("नवंबर 2026");
    expect(html).toContain("Asha Devi");
    expect(html).toContain("VC VC1001");
    expect(html).toContain("महीने का किराया");
    expect(html).toContain("प्लान बदला");
    expect(html).toContain("बिल में बदलाव (Repair visit)");
    expect(html).toContain("पुराना बाकी");
    expect(html).toContain("₹775");
    expect(html).toContain("20 नव 2026 को भरना है");
    expect(html).toContain("₹375");
    expect(html).not.toMatch(/tax invoice|टैक्स/i);
    expect(html).not.toContain('addEventListener("load"');
  });

  it("escapes every value and opens the print dialog on ?auto=1", () => {
    const html = billPrintHtml(
      { ...billView(), customer: { ...billView().customer, name: "<script>x</script>" } },
      billsT("en"),
      "en",
      { autoPrint: true, now: NOW },
    );
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain("Thank you &lt;3");
    expect(html).toContain('addEventListener("load"');
    expect(html).toContain("To pay on 20 Nov 2026");
    expect(escapeHtml(`a&"'`)).toBe("a&amp;&quot;&#39;");
  });

  it("says credit or nothing to pay on the day, and marks a cancelled bill", () => {
    const base = billView();
    const credit = billPrintHtml(
      { ...base, balance: { balancePaise: -5_000 as never, creditPaise: 5_000 as never } },
      billsT("en"),
      "en",
      { autoPrint: false, now: NOW },
    );
    expect(credit).toContain("Credit on 20 Nov 2026");
    const cancelled = billPrintHtml(
      {
        ...base,
        bill: { ...base.bill, status: "void", payState: "void" },
        balance: { balancePaise: 0 as never, creditPaise: 0 as never },
      },
      billsT("en"),
      "en",
      { autoPrint: false, now: NOW },
    );
    expect(cancelled).toContain("Cancelled bill");
    expect(cancelled).toContain("Nothing to pay on 20 Nov 2026");
  });
});
