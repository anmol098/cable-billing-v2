/**
 * The printable A5 bill (T-047, PLAN §12.1 "Printable A5 bill"): one self-contained HTML page in
 * the operator's language (`settings.default_language`), printed with the browser's own print
 * dialog (`@page { size: A5 }`). Plain strings with every value escaped; no React runtime. The
 * only script is the Print button (and `?auto=1` opening the print dialog once).
 *
 * Every colour, font, type size, radius, border width and spacing step comes from
 * `packages/design-tokens/tokens.json`, the same way as the public receipt page (T-050). The
 * paper size (A5) is the one physical constant. Hyper-minimal: black on white, hairlines.
 *
 * What it shows: the operator (name, address, phone), "Bill", bill no., month, date, the customer
 * (name, code, area, phone), the lines per connection (VC) and other charges, old due / credit,
 * this month, total to pay, what the customer owes on the day it is printed, and the footer. It
 * never calls itself a tax invoice (B-019).
 */
import type { BillDetailView, BillLineView } from "@cb/core";
import tokens from "@cb/design-tokens/tokens.json";
import type { DisplayLocale } from "@cb/domain";
import { formatRupees } from "@cb/ui";
import { istDate, lineKey, monthText, type Translate } from "./format";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

const REM_BASE_PX = 16;
const rem = (px: number) => `${px / REM_BASE_PX}rem`;
/** A spacing step as a literal (`@page` can't read custom properties). */
const space = (steps: number) => rem(tokens.space.base * steps);
const family = (names: readonly string[]) =>
  names.map((name) => (/\s/.test(name) ? `"${name}"` : name)).join(", ");
const type = tokens.type.web;
const color = { ...tokens.color, ...tokens.semantic } as Record<string, { value: string }>;
const c = (name: string) => color[name]?.value ?? "";

/** The page's only stylesheet. */
export const BILL_PRINT_CSS = [
  `@page{size:A5 portrait;margin:${space(5)}}`,
  "*{box-sizing:border-box}",
  `body{margin:0;background:${c("bg")};color:${c("text")};font-family:${family(tokens.font.family.sans.value)};font-size:${rem(type.base)};font-weight:${tokens.font.weight.regular.value};line-height:1.4}`,
  `main{max-width:148mm;margin:0 auto;padding:${space(4)}}`,
  "h1,h2,p{margin:0}",
  `h1{font-size:${rem(type.xl)};font-weight:${tokens.font.weight.strong.value}}`,
  `h2{font-size:${rem(type.lg)};font-weight:${tokens.font.weight.strong.value};margin-top:${space(3)}}`,
  `.muted{color:${c("textMuted")}}`,
  ".center{text-align:center}",
  `.num{font-family:${family(tokens.font.family.numeric.value)};font-feature-settings:"tnum";white-space:nowrap}`,
  `hr{border:0;border-top:${tokens.border.hairline}px solid ${c("text")};margin:${space(3)} 0}`,
  "dl{margin:0}",
  `.field{display:flex;justify-content:space-between;gap:${space(4)};padding:${space(0.5)} 0}`,
  ".field dd{margin:0;text-align:right}",
  `.vc{font-weight:${tokens.font.weight.strong.value};padding-top:${space(2)}}`,
  `.line{padding-left:${space(3)}}`,
  `.total{font-size:${rem(type.lg)};font-weight:${tokens.font.weight.strong.value}}`,
  `.big{font-size:${rem(type["2xl"])};font-weight:${tokens.font.weight.strong.value}}`,
  `.stamp{display:inline-block;border:${tokens.border.strong}px solid ${c("text")};border-radius:${rem(tokens.radius.md)};padding:${space(1)} ${space(3)};font-weight:${tokens.font.weight.strong.value}}`,
  `.toolbar{display:flex;gap:${space(3)};align-items:center;margin-bottom:${space(4)}}`,
  `.button{display:inline-flex;align-items:center;justify-content:center;min-height:${rem(tokens.size.primaryButton.web)};padding:0 ${space(6)};background:${c("accent")};color:${c("onAccent")};border:0;border-radius:${rem(tokens.radius.md)};font:inherit;font-weight:${tokens.font.weight.strong.value};font-size:${rem(type.lg)};cursor:pointer}`,
  `.link{color:${c("text")};min-height:${rem(tokens.size.touchMin.web)};display:inline-flex;align-items:center}`,
  `@media print{.toolbar{display:none}main{max-width:none;padding:0}}`,
].join("");

const money = (paise: number) => escapeHtml(formatRupees(paise).text);

function field(label: string, value: string, options: { cls?: string; num?: boolean } = {}) {
  return `<div class="field${options.cls ? ` ${options.cls}` : ""}"><dt>${escapeHtml(label)}</dt><dd${
    options.num ? ' class="num"' : ""
  }>${value}</dd></div>`;
}

function lines(t: Translate, list: readonly BillLineView[]): string {
  return list
    .map((line) => {
      const word = t(`line.${lineKey(line)}`);
      const reason = line.adjustment?.reason ? ` (${line.adjustment.reason})` : "";
      return field(`${word}${reason}`, money(line.amountPaise), { cls: "line", num: true });
    })
    .join("");
}

export interface BillPrintOptions {
  /** Open the print dialog once the page has loaded (`?auto=1`). */
  readonly autoPrint: boolean;
  /** When it is printed (for "To pay on {date}"). */
  readonly now: Date;
}

/** The complete printable page for a bill, in `locale` (the operator's language). */
export function billPrintHtml(
  view: BillDetailView,
  t: Translate,
  locale: DisplayLocale,
  options: BillPrintOptions,
): string {
  const { bill, customer, operator, connections, otherLines, balance } = view;
  const today = istDate(options.now, locale);
  const body: string[] = [];
  body.push(
    `<div class="toolbar"><button type="button" class="button" id="print">${escapeHtml(
      t("print.print"),
    )}</button><a class="link" href="/bills/${escapeHtml(bill.id)}">${escapeHtml(t("print.back"))}</a></div>`,
  );
  body.push(`<header class="center"><h1>${escapeHtml(operator.name)}</h1>`);
  if (operator.address) body.push(`<p class="muted">${escapeHtml(operator.address)}</p>`);
  if (operator.phone) body.push(`<p class="num">${escapeHtml(operator.phone)}</p>`);
  body.push("</header><hr>");
  body.push(`<p class="center"><span class="stamp">${escapeHtml(t("print.title"))}</span></p>`);
  if (bill.status === "void") {
    body.push(`<p class="center big">${escapeHtml(t("print.cancelled"))}</p>`);
  }
  body.push("<dl>");
  body.push(field(t("print.number"), escapeHtml(bill.invoiceNumber), { num: true }));
  body.push(field(t("print.month"), escapeHtml(monthText(bill.period, locale))));
  body.push(field(t("print.date"), escapeHtml(istDate(bill.issuedAt, locale))));
  body.push("</dl><hr><dl>");
  body.push(field(t("print.customer"), `<strong>${escapeHtml(customer.name)}</strong>`));
  body.push(field(t("print.code"), escapeHtml(customer.code), { num: true }));
  if (customer.areaName) body.push(field(t("print.area"), escapeHtml(customer.areaName)));
  if (customer.phone) body.push(field(t("print.phone"), escapeHtml(customer.phone), { num: true }));
  body.push("</dl><hr><dl>");
  for (const connection of connections) {
    body.push(
      field(t("print.vc", { number: connection.vcNumber }), money(connection.totalPaise), {
        cls: "vc",
        num: true,
      }),
    );
    body.push(lines(t, connection.lines));
  }
  if (otherLines.length > 0) body.push(lines(t, otherLines));
  body.push("</dl><hr><dl>");
  if (bill.kind === "regular") {
    body.push(
      field(
        bill.openingBalancePaise < 0 ? t("print.previous_credit") : t("print.previous_due"),
        money(Math.abs(bill.openingBalancePaise)),
        { num: true },
      ),
    );
  }
  body.push(field(t("print.this_month"), money(bill.chargesPaise), { num: true }));
  if (bill.kind === "regular") {
    body.push(
      field(t("print.total"), money(Math.max(bill.totalDuePaise, 0)), { cls: "total", num: true }),
    );
  }
  body.push("</dl><hr><dl>");
  if (balance.balancePaise > 0) {
    body.push(
      field(t("print.due_today", { date: today }), money(balance.balancePaise), {
        cls: "big",
        num: true,
      }),
    );
  } else if (balance.balancePaise < 0) {
    body.push(
      field(t("print.credit_today", { date: today }), money(-balance.balancePaise), {
        cls: "total",
        num: true,
      }),
    );
  } else {
    body.push(`<p class="total">${escapeHtml(t("print.nothing_due_today", { date: today }))}</p>`);
  }
  body.push("</dl>");
  if (operator.footer) body.push(`<hr><p class="center muted">${escapeHtml(operator.footer)}</p>`);

  const script = [
    'document.getElementById("print").addEventListener("click",function(){window.print()});',
    options.autoPrint ? 'window.addEventListener("load",function(){window.print()});' : "",
  ].join("");
  return [
    "<!doctype html>",
    `<html lang="${escapeHtml(locale)}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex,nofollow">',
    `<title>${escapeHtml(t("print.page_title", { number: bill.invoiceNumber }))}</title>`,
    `<style>${BILL_PRINT_CSS}</style>`,
    "</head>",
    `<body><main>${body.join("")}</main><script>${script}</script></body>`,
    "</html>",
  ].join("");
}
