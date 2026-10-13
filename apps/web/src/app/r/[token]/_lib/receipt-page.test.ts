// @vitest-environment node
/**
 * The public receipt's content, HTML and PDF (T-050) without a database: field order and wording
 * in both languages, IST date/time, Indian grouping, privacy (only what the view carries), HTML
 * escaping, no scripts, the identical generic pages, token-only styling, and a real A5 PDF with
 * the bundled Devanagari font.
 */
import type { PublicReceipt } from "@cb/core";
import tokens from "@cb/design-tokens/tokens.json";
import { describe, expect, it } from "vitest";
import { istClock, istDateTime, receiptDocument } from "./content";
import { escapeHtml, genericPageHtml, receiptPageHtml } from "./html";
import { receiptLocale, translatorFor } from "./i18n";
import { pdfFileName, receiptPdf } from "./pdf";
import { RECEIPT_PAGE_CSS } from "./style";

const RECEIPT: PublicReceipt = {
  operator: {
    name: "Shree Ganesh Cable",
    phone: "98111 22233",
    footer: "Thank you",
    language: "hi",
  },
  receiptNumber: "R-2610-00045",
  provisionalRef: "P-K7Q-0012",
  // 13 Oct 2026, 4:05 PM IST.
  recordedAt: new Date("2026-10-13T10:35:00.000Z"),
  amountPaise: 12_345_600 as PublicReceipt["amountPaise"],
  method: "upi",
  customer: { firstName: "Ramesh", maskedPhone: "XXXXXX3210" },
  cancelled: false,
  bills: [
    { period: "2026-09-01", leftPaise: 0 as PublicReceipt["amountPaise"] },
    { period: "2026-10-01", leftPaise: 5_000 as PublicReceipt["amountPaise"] },
    { period: null, leftPaise: 0 as PublicReceipt["amountPaise"] },
  ],
  balanceAfter: { kind: "due", paise: 5_000 as PublicReceipt["amountPaise"] },
};

const links = {
  pdf: "/r/tok/pdf?lang=en",
  languages: { hi: "/r/tok?lang=hi", en: "/r/tok?lang=en" },
};

describe("receipt content", () => {
  it("formats IST clock times like the printed receipt", () => {
    const t = translatorFor("en");
    expect(istClock(new Date("2026-10-13T10:35:00Z"), t)).toBe("4:05 PM");
    expect(istClock(new Date("2026-10-12T18:30:00Z"), t)).toBe("12:00 AM");
    expect(istClock(new Date("2026-10-13T06:30:00Z"), t)).toBe("12:00 PM");
    expect(istDateTime(new Date("2026-10-12T19:00:00Z"), "hi", translatorFor("hi"))).toBe(
      "13 अक्टू 2026, 12:30 AM",
    );
  });

  it("has the printed receipt's lines in English", () => {
    const doc = receiptDocument(RECEIPT, "en", translatorFor("en"));
    expect(doc).toMatchObject({
      pageTitle: "Receipt R-2610-00045",
      operatorName: "Shree Ganesh Cable",
      operatorPhone: { dial: "9811122233", text: "Phone: 98111 22233" },
      heading: "Receipt",
      cancelled: null,
      receiptFields: [
        { label: "Receipt no.", value: "R-2610-00045" },
        { label: "Temporary no.", value: "P-K7Q-0012" },
        { label: "Date", value: "13 Oct 2026, 4:05 PM" },
      ],
      customerFields: [
        { label: "Customer", value: "Ramesh" },
        { label: "Phone", value: "XXXXXX3210" },
      ],
      amount: "₹1,23,456",
      method: { kind: "upi", label: "UPI" },
      bills: ["Sep 2026 bill paid", "Oct 2026 bill: ₹50 left", "Old due paid"],
      balance: { tone: "due", label: "Due now", amount: "₹50" },
      footer: "Thank you",
    });
  });

  it("and in Hindi", () => {
    const doc = receiptDocument(
      {
        ...RECEIPT,
        balanceAfter: { kind: "credit", paise: 2_000 as PublicReceipt["amountPaise"] },
      },
      "hi",
      translatorFor("hi"),
    );
    expect(doc.receiptFields.map((f) => f.label)).toEqual(["रसीद नं.", "अस्थायी नं.", "तारीख"]);
    expect(doc.receiptFields[2]?.value).toBe("13 अक्टू 2026, 4:05 PM");
    expect(doc.bills).toEqual([
      "सित 2026 का बिल पूरा",
      "अक्टू 2026 का बिल: ₹50 बाकी",
      "पुराना बाकी पूरा",
    ]);
    expect(doc.balance).toEqual({ tone: "credit", label: "एडवांस", amount: "₹20" });
  });

  it("marks a cancelled receipt and leaves out empty customer fields", () => {
    const doc = receiptDocument(
      {
        ...RECEIPT,
        cancelled: true,
        bills: [],
        balanceAfter: null,
        customer: { firstName: null, maskedPhone: null },
      },
      "en",
      translatorFor("en"),
    );
    expect(doc.cancelled).toEqual({
      stamp: "Cancelled",
      note: "The office cancelled this payment. This receipt is not valid.",
    });
    expect(doc.customerFields).toEqual([]);
    expect(doc.balance).toBeNull();
  });

  it("picks the language from ?lang, else the operator's default", () => {
    expect(receiptLocale(new URL("https://x.test/r/t?lang=en"), "hi")).toBe("en");
    expect(receiptLocale(new URL("https://x.test/r/t?lang=xx"), "hi")).toBe("hi");
    expect(receiptLocale(new URL("https://x.test/r/t"), "en")).toBe("en");
  });
});

describe("receipt HTML", () => {
  it("is a script-free, noindex page with the receipt in order", () => {
    const t = translatorFor("en");
    const html = receiptPageHtml(receiptDocument(RECEIPT, "en", t), t, links);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('<meta name="robots" content="noindex,nofollow,noarchive">');
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>Receipt R-2610-00045</title>");
    expect(html).toContain('href="tel:9811122233"');
    expect(html).toContain('href="/r/tok/pdf?lang=en" download');
    const order = [
      "Shree Ganesh Cable",
      "R-2610-00045",
      "13 Oct 2026",
      "Ramesh",
      "₹1,23,456",
      "UPI",
      "Sep 2026 bill paid",
      "Due now",
      "Thank you",
      "Download PDF",
    ];
    const body = html.slice(html.indexOf("<body>"));
    const positions = order.map((text) => body.indexOf(text));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // A few KB, not a JavaScript app.
    expect(Buffer.byteLength(html)).toBeLessThan(16_000);
  });

  it("escapes every value", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
    const t = translatorFor("en");
    const evil = {
      ...RECEIPT,
      operator: { ...RECEIPT.operator, name: "<script>alert(1)</script>", footer: '"><img src=x>' },
    };
    const html = receiptPageHtml(receiptDocument(evil, "en", t), t, links);
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("shows the cancelled stamp instead of bills", () => {
    const t = translatorFor("hi");
    const doc = receiptDocument(
      { ...RECEIPT, cancelled: true, bills: [], balanceAfter: null },
      "hi",
      t,
    );
    const html = receiptPageHtml(doc, t, links);
    expect(html).toContain('<span class="stamp" role="status">रद्द</span>');
    expect(html).toContain('class="card cancelled"');
    expect(html).not.toContain("बिल पूरा");
  });

  it("generic pages are bilingual, script-free, noindex and the same every time", () => {
    for (const kind of ["unavailable", "rate_limited", "error"] as const) {
      const html = genericPageHtml(kind);
      expect(html).toBe(genericPageHtml(kind));
      expect(html).not.toMatch(/<script/i);
      expect(html).toContain('content="noindex,nofollow,noarchive"');
      expect(html).toContain('lang="hi"');
      expect(html).toContain('lang="en"');
    }
    expect(genericPageHtml("unavailable")).toContain("This link does not work");
    expect(genericPageHtml("unavailable")).toContain("यह लिंक काम नहीं कर रहा");
  });
});

describe("receipt styles", () => {
  it("come from the design tokens only (no shadows or gradients)", () => {
    expect(RECEIPT_PAGE_CSS).toContain(`--color-cash:${tokens.semantic.cash.value}`);
    expect(RECEIPT_PAGE_CSS).toContain(`--color-upi:${tokens.semantic.upi.value}`);
    expect(RECEIPT_PAGE_CSS).toContain(`--text-amount:${tokens.type.web.amount / 16}rem`);
    // Every hex colour in the stylesheet is a token value.
    const tokenColours = new Set(
      [...Object.values(tokens.color), ...Object.values(tokens.semantic)].map((t) =>
        t.value.toLowerCase(),
      ),
    );
    for (const hex of RECEIPT_PAGE_CSS.match(/#[0-9a-f]{3,8}\b/gi) ?? []) {
      expect(tokenColours.has(hex.toLowerCase())).toBe(true);
    }
    expect(RECEIPT_PAGE_CSS).not.toMatch(/shadow|gradient/);
    // Sizes outside :root are token variables or spacing multiples (no px literals).
    const rules = RECEIPT_PAGE_CSS.slice(RECEIPT_PAGE_CSS.indexOf("}") + 1);
    expect(rules).not.toMatch(/\d+px/);
  });
});

describe("receipt PDF", () => {
  it("is an A5 PDF with the Devanagari font embedded", async () => {
    const t = translatorFor("hi");
    const pdf = await receiptPdf(
      receiptDocument(RECEIPT, "hi", t),
      new Date("2026-10-13T10:40:00Z"),
    );
    const text = pdf.toString("latin1");
    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text).toMatch(/\/MediaBox \[0 0 419\.53 595\.28\]/);
    expect(text).toContain("NotoSansDevanagari");
    expect(pdf.length).toBeLessThan(200_000);
  }, 30_000);

  it("names the file after the receipt number only", () => {
    expect(pdfFileName("R-2610-00045")).toBe("receipt-R-2610-00045.pdf");
    expect(pdfFileName('R/26"10')).toBe("receipt-R_26_10.pdf");
  });
});
