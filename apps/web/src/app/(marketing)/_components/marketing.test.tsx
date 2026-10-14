import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { RECEIPT_LINK_TTL_DAYS } from "@cb/core";
import { paise } from "@cb/domain";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { clientMessages, SERVER_ONLY_NAMESPACES } from "@/i18n/client-messages";
import { renderWithIntl } from "@/test/intl";
import en from "../../../../messages/en.json";
import hi from "../../../../messages/hi.json";
import {
  GRACE_DAYS,
  GST_PERCENT,
  gstOn,
  marketingFacts,
  RECEIPT_LINK_DAYS,
  SUBSCRIPTION_PRICE_PAISE,
  TRIAL_DAYS,
} from "../_lib/facts";
import { ContactContent, formatIndianMobile, whatsappLink } from "./contact-content";
import { MarketingFrame } from "./frame";
import { HOME_FEATURES, HOME_STEPS, HomeContent } from "./home-content";
import { LegalContent, PRIVACY_SECTIONS, TERMS_SECTIONS } from "./legal";
import { PRICING_FAQ, PRICING_INCLUDED, PricingContent } from "./pricing-content";

const noop = () => {};

function linkTo(name: string | RegExp) {
  return screen.getByRole("link", { name });
}

/** Every leaf key of a nested message object, dotted (`home.features.title`). */
function leafKeys(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

function lookup(messages: unknown, dotted: string): unknown {
  return dotted
    .split(".")
    .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], messages);
}

describe("facts (D-14, D-20, D-22)", () => {
  it("₹400 + 18% GST = ₹472, 30-day trial, 15-day grace, 90-day receipt links", () => {
    expect(SUBSCRIPTION_PRICE_PAISE).toBe(40_000);
    expect(GST_PERCENT).toBe(18);
    expect(gstOn(SUBSCRIPTION_PRICE_PAISE, GST_PERCENT)).toBe(7_200);
    expect(marketingFacts()).toEqual({
      price: "₹400",
      gst_amount: "₹72",
      total: "₹472",
      gst: 18,
      days: 30,
      grace: 15,
    });
    expect(TRIAL_DAYS).toBe(30);
    expect(GRACE_DAYS).toBe(15);
    expect(RECEIPT_LINK_DAYS).toBe(RECEIPT_LINK_TTL_DAYS);
  });

  it("never rounds money: inexact GST throws", () => {
    expect(() => gstOn(paise(1), GST_PERCENT)).toThrow(RangeError);
    expect(gstOn(paise(100), GST_PERCENT)).toBe(18);
  });
});

describe("MarketingFrame", () => {
  it("shows Sign in for guests, the footer pages and the language switch", () => {
    renderWithIntl(
      <MarketingFrame signedIn={false} locale="en" localeAction={noop}>
        <p>page</p>
      </MarketingFrame>,
    );
    expect(linkTo("Sign in")).toHaveAttribute("href", "/login");
    expect(screen.queryByRole("link", { name: "Open app" })).toBeNull();
    expect(linkTo("Cable Billing")).toHaveAttribute("href", "/");
    expect(linkTo("Skip to content")).toHaveAttribute("href", "#main");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
    const footer = screen.getByRole("navigation", { name: "More pages" });
    expect(
      within(footer)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["Price", "/pricing"],
      ["Privacy policy", "/privacy"],
      ["Terms of use", "/terms"],
      ["Contact us", "/contact"],
    ]);
    expect(screen.getByRole("button", { name: "हिं, हिंदी" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("says Open app when a session cookie is present (still /login, which forwards)", () => {
    renderWithIntl(
      <MarketingFrame signedIn locale="hi" localeAction={noop}>
        <p>page</p>
      </MarketingFrame>,
      "hi",
    );
    expect(linkTo("ऐप खोलें")).toHaveAttribute("href", "/login");
    expect(screen.getByRole("button", { name: "हिं, हिंदी" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("HomeContent", () => {
  it("says what the app does in plain words, with one way to start", () => {
    renderWithIntl(<HomeContent />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Cable Billing");
    expect(screen.getAllByText("30 days free. Then ₹400 a month + GST.")).toHaveLength(2);
    for (const link of screen.getAllByRole("link", { name: "Start free trial" })) {
      expect(link).toHaveAttribute("href", "/signup");
    }
    expect(linkTo("Sign in")).toHaveAttribute("href", "/login");
    const features = screen.getAllByRole("heading", { level: 3 });
    expect(features.map((h) => h.textContent)).toEqual([
      "Customers and connections",
      "Bills every month",
      "App for linemen",
      "Receipts",
      "Cash check",
      "Who has to pay",
      "Hindi and English",
    ]);
    // Every feature has its icon next to the word (PLAN §2.2 rule 3).
    expect(document.querySelectorAll("li svg[data-icon]")).toHaveLength(HOME_FEATURES.length);
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(
      HOME_FEATURES.length + HOME_STEPS.length,
    );
  });

  it("renders in Hindi", () => {
    renderWithIntl(<HomeContent />, "hi");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("केबल बिलिंग");
    expect(screen.getAllByText("30 दिन फ़्री। उसके बाद ₹400 महीना + GST।")).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "फ़्री ट्रायल शुरू करें" })[0]).toHaveAttribute(
      "href",
      "/signup",
    );
  });
});

describe("PricingContent", () => {
  it("shows the number first, what is included and the questions", () => {
    renderWithIntl(<PricingContent />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Price");
    expect(screen.getByTestId("price")).toHaveTextContent("₹400");
    expect(screen.getByText("₹472 a month with 18% GST")).toBeInTheDocument();
    expect(screen.getByText("Unlimited customers")).toBeInTheDocument();
    expect(screen.getByText("First 30 days free")).toBeInTheDocument();
    expect(
      screen.getByText("The price is ₹400 a month. GST at 18% is ₹72, so you pay ₹472."),
    ).toBeInTheDocument();
    expect(screen.getByText(/keeps working for 15 more days/)).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(PRICING_FAQ.length);
    expect(linkTo("Start free trial")).toHaveAttribute("href", "/signup");
  });

  it("renders in Hindi", () => {
    renderWithIntl(<PricingContent />, "hi");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("कीमत");
    expect(screen.getByText("18% GST के साथ ₹472 महीना")).toBeInTheDocument();
    expect(screen.getByText("ग्राहक जितने चाहें")).toBeInTheDocument();
  });
});

describe("LegalContent", () => {
  it.each([
    ["privacy", "Privacy policy", PRIVACY_SECTIONS.length],
    ["terms", "Terms of use", TERMS_SECTIONS.length],
  ] as const)("%s is clearly marked as a draft for legal review", (doc, title, sections) => {
    renderWithIntl(<LegalContent doc={doc} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(title);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Draft: for legal review");
    expect(note).toHaveTextContent("A lawyer has not checked it yet, and it is not final.");
    expect(note).toHaveTextContent("Draft of 13 Oct 2026");
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(sections);
    expect(linkTo("Contact us")).toHaveAttribute("href", "/contact");
  });

  it.each(["privacy", "terms"] as const)("%s is marked as a draft in Hindi too", (doc) => {
    renderWithIntl(<LegalContent doc={doc} />, "hi");
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("ड्राफ़्ट: कानूनी जाँच के लिए");
    expect(note).toHaveTextContent("13 अक्टू 2026 का ड्राफ़्ट");
  });

  it("states the facts the BRD/PRD fix: receipt links, receipts are not GST invoices, honest messaging", () => {
    renderWithIntl(<LegalContent doc="privacy" />);
    expect(screen.getByText(/It stops working after 90 days/)).toBeInTheDocument();
    expect(screen.getByText(/It is not deleted when the subscription ends/)).toBeInTheDocument();
  });

  it("terms: price, view-only mode, receipts and WhatsApp/SMS", () => {
    renderWithIntl(<LegalContent doc="terms" />);
    expect(
      screen.getByText(
        /The first 30 days are free\. After that the price is ₹400 a month \+ GST \(₹472 a month\)/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/They are not GST tax invoices\./)).toBeInTheDocument();
    expect(screen.getByText(/We do not send these messages ourselves/)).toBeInTheDocument();
  });
});

describe("ContactContent", () => {
  it("links the support email, phone and WhatsApp when configured", () => {
    renderWithIntl(<ContactContent email="help@example.test" phone="+919876543210" />);
    expect(linkTo("help@example.test")).toHaveAttribute("href", "mailto:help@example.test");
    expect(linkTo("Call +91 98765 43210")).toHaveAttribute("href", "tel:+919876543210");
    expect(linkTo("Chat on WhatsApp")).toHaveAttribute("href", "https://wa.me/919876543210");
    expect(screen.queryByText("Contact details will be added here soon.")).toBeNull();
    expect(linkTo("Get a new one")).toHaveAttribute("href", "/reset");
  });

  it("shows only the email when there is no phone", () => {
    renderWithIntl(<ContactContent email="help@example.test" />);
    expect(screen.queryByRole("link", { name: /WhatsApp/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /^Call/ })).toBeNull();
  });

  it("says honestly when nothing is configured (local, previews)", () => {
    renderWithIntl(<ContactContent />, "hi");
    expect(screen.getByText("संपर्क की जानकारी जल्द ही यहाँ लिखी जाएगी।")).toBeInTheDocument();
  });

  it("formats Indian mobiles", () => {
    expect(formatIndianMobile("+919876543210")).toBe("+91 98765 43210");
    expect(whatsappLink("+919876543210")).toBe("https://wa.me/919876543210");
  });
});

describe("marketing messages", () => {
  const used = new Set<string>([
    ...leafKeys(en.marketing.nav, "nav"),
    ...leafKeys(en.marketing.legal, "legal"),
    ...leafKeys(en.marketing.contact, "contact"),
    ...["description", "lead", "languages", "trial_line", "no_card", "already"].map(
      (key) => `home.${key}`,
    ),
    "home.features.title",
    ...HOME_FEATURES.flatMap(({ id }) => [`home.features.${id}.title`, `home.features.${id}.text`]),
    "home.steps.title",
    ...HOME_STEPS.map((step) => `home.steps.${step}`),
    "home.cta.title",
    ...["title", "description", "lead", "per_month", "total", "included", "no_card"].map(
      (key) => `pricing.${key}`,
    ),
    ...PRICING_INCLUDED.map((key) => `pricing.${key}`),
    "pricing.faq.title",
    ...PRICING_FAQ.flatMap((id) => [`pricing.faq.${id}.q`, `pricing.faq.${id}.a`]),
    ...(["privacy", "terms"] as const).flatMap((doc) => [
      `${doc}.title`,
      `${doc}.description`,
      `${doc}.intro`,
      ...(doc === "privacy" ? PRIVACY_SECTIONS : TERMS_SECTIONS).flatMap((section) => {
        const parts: readonly string[] = [
          "title",
          ...("paragraphs" in section ? section.paragraphs : []),
          ...("list" in section ? section.list : []),
        ];
        return parts.map((part) => `${doc}.${section.id}.${part}`);
      }),
    ]),
  ]);

  it("every key the pages use exists, non-empty, in English and Hindi", () => {
    for (const key of used) {
      expect(lookup(en.marketing, key), `en marketing.${key}`).toEqual(expect.any(String));
      expect(lookup(hi.marketing, key), `hi marketing.${key}`).toEqual(expect.any(String));
      expect((lookup(hi.marketing, key) as string).trim()).not.toBe("");
    }
  });

  it("has no key the pages don't use", () => {
    expect(leafKeys(en.marketing).filter((key) => !used.has(key))).toEqual([]);
  });

  it("never claims a WhatsApp/SMS message was sent or delivered", () => {
    for (const key of leafKeys(en.marketing)) {
      const text = lookup(en.marketing, key) as string;
      if (/whatsapp|sms/i.test(text)) expect(text, key).not.toMatch(/\b(sent|delivered)\b/i);
    }
    for (const key of leafKeys(hi.marketing)) {
      expect(lookup(hi.marketing, key) as string, key).not.toMatch(/भेजा गया|डिलीवर/);
    }
  });
});

describe("no client JavaScript of their own", () => {
  // Vitest runs from apps/web (same approach as the shell's nav test).
  const root = join(process.cwd(), "src", "app", "(marketing)");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });

  it("no file in (marketing) is a client component", () => {
    const sources = files(root).filter((file) => /\.tsx?$/.test(file) && !/\.test\./.test(file));
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/^\s*["']use client["']/m);
    }
  });

  it("the marketing text is not sent to the browser on every page", () => {
    expect(SERVER_ONLY_NAMESPACES).toContain("marketing");
    const client = clientMessages(en);
    expect(client).not.toHaveProperty("marketing");
    expect(client).toHaveProperty("common");
    expect(client).toHaveProperty("shell");
  });
});
