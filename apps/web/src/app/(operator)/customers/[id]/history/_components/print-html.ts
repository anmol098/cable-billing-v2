/**
 * The printable customer statement (T-049; BRD §12; "downloadable statement for a date range"):
 * one self-contained A4 HTML page in the operator's language (`settings.default_language`, like
 * the printed bill, T-047), printed or saved as a PDF with the browser's own print dialog. Plain
 * strings with every value escaped; no React runtime; the only script is the Print button (and
 * `?auto=1` opening the print dialog once).
 *
 * Every colour, font, type size, border width and spacing step comes from
 * `packages/design-tokens/tokens.json` (as T-047's bill and T-050's receipt page do); the paper
 * size (A4) is the one physical constant. Hyper-minimal: black on white, hairlines.
 *
 * What it shows: the operator, "Account statement", the customer, the days, every line (date,
 * what, +/− amount, balance after), the balance before and at the end, totals, the print date,
 * and "This is not a receipt."
 */
import type { CustomerStatementView } from "@cb/core";
import tokens from "@cb/design-tokens/tokens.json";
import { businessDateOf, type DisplayLocale, formatBusinessDate } from "@cb/domain";
import { formatRupees } from "@cb/ui";
import type { Translate } from "@/components/bills/format";
import { escapeHtml } from "@/components/bills/print-html";
import { describeLine, signedRupees } from "./lines";
import { rangeText } from "./range";

const REM_BASE_PX = 16;
const rem = (px: number) => `${px / REM_BASE_PX}rem`;
/** A spacing step as a literal (`@page` can't read custom properties). */
const space = (steps: number) => rem(tokens.space.base * steps);
const family = (names: readonly string[]) =>
  names.map((name) => (/\s/.test(name) ? `"${name}"` : name)).join(", ");
const type = tokens.type.web;
const color = { ...tokens.color, ...tokens.semantic } as Record<string, { value: string }>;
const c = (name: string) => color[name]?.value ?? "";
const strong = tokens.font.weight.strong.value;

/** The page's only stylesheet. */
export const STATEMENT_PRINT_CSS = [
  `@page{size:A4 portrait;margin:${space(6)}}`,
  "*{box-sizing:border-box}",
  `body{margin:0;background:${c("bg")};color:${c("text")};font-family:${family(tokens.font.family.sans.value)};font-size:${rem(type.sm)};font-weight:${tokens.font.weight.regular.value};line-height:1.4}`,
  `main{max-width:210mm;margin:0 auto;padding:${space(4)}}`,
  "h1,h2,p{margin:0}",
  `h1{font-size:${rem(type.xl)};font-weight:${strong}}`,
  `.muted{color:${c("textMuted")}}`,
  ".center{text-align:center}",
  ".end{text-align:right}",
  `.num{font-family:${family(tokens.font.family.numeric.value)};font-feature-settings:"tnum";white-space:nowrap}`,
  `hr{border:0;border-top:${tokens.border.hairline}px solid ${c("text")};margin:${space(3)} 0}`,
  "dl{margin:0}",
  `.field{display:flex;justify-content:space-between;gap:${space(4)};padding:${space(0.5)} 0}`,
  ".field dd{margin:0;text-align:right}",
  `.stamp{display:inline-block;border:${tokens.border.strong}px solid ${c("text")};border-radius:${rem(tokens.radius.md)};padding:${space(1)} ${space(3)};font-weight:${strong}}`,
  "table{width:100%;border-collapse:collapse}",
  `th,td{padding:${space(1)} ${space(1.5)};border-bottom:${tokens.border.hairline}px solid ${c("text")};vertical-align:top;text-align:left}`,
  `th{font-weight:${strong}}`,
  ".amount,.balance{text-align:right}",
  `.what small{display:block;color:${c("textMuted")}}`,
  `.carry td{font-weight:${strong}}`,
  `.total{font-size:${rem(type.lg)};font-weight:${strong}}`,
  `.toolbar{display:flex;gap:${space(3)};align-items:center;margin-bottom:${space(4)}}`,
  `.button{display:inline-flex;align-items:center;justify-content:center;min-height:${rem(tokens.size.primaryButton.web)};padding:0 ${space(6)};background:${c("accent")};color:${c("onAccent")};border:0;border-radius:${rem(tokens.radius.md)};font:inherit;font-weight:${strong};font-size:${rem(type.lg)};cursor:pointer}`,
  `.link{color:${c("text")};min-height:${rem(tokens.size.touchMin.web)};display:inline-flex;align-items:center}`,
  "thead{display:table-header-group}tr{break-inside:avoid}",
  "@media print{.toolbar{display:none}main{max-width:none;padding:0}}",
].join("");

/** A balance in words for paper: "₹500 due" / "₹200 credit" / "₹0". */
function balanceText(paise: number, t: Translate): string {
  const amount = formatRupees(Math.abs(paise)).text;
  if (paise > 0) return `${amount} ${t("summary.due")}`;
  if (paise < 0) return `${amount} ${t("summary.credit")}`;
  return amount;
}

function field(label: string, value: string, options: { cls?: string; num?: boolean } = {}) {
  return `<div class="field${options.cls ? ` ${options.cls}` : ""}"><dt>${escapeHtml(label)}</dt><dd${
    options.num ? ' class="num"' : ""
  }>${value}</dd></div>`;
}

export interface StatementPrintOptions {
  /** Open the print dialog once the page has loaded (`?auto=1`). */
  readonly autoPrint: boolean;
  /** Where "Back" goes (the History tab with the same days). */
  readonly backHref: string;
}

/** The complete printable statement, in `locale` (the operator's language). */
export function statementPrintHtml(
  view: CustomerStatementView,
  t: Translate,
  tb: Translate,
  locale: DisplayLocale,
  options: StatementPrintOptions,
): string {
  const { customer, operator, range, totals } = view;
  const date = (value: Parameters<typeof formatBusinessDate>[0]) =>
    escapeHtml(formatBusinessDate(value, locale));
  const body: string[] = [];
  body.push(
    `<div class="toolbar"><button type="button" class="button" id="print">${escapeHtml(
      t("print.print"),
    )}</button><a class="link" href="${escapeHtml(options.backHref)}">${escapeHtml(t("print.back"))}</a></div>`,
  );
  body.push(`<header class="center"><h1>${escapeHtml(operator.name)}</h1>`);
  if (operator.address) body.push(`<p class="muted">${escapeHtml(operator.address)}</p>`);
  if (operator.phone) body.push(`<p class="num">${escapeHtml(operator.phone)}</p>`);
  body.push("</header><hr>");
  body.push(`<p class="center"><span class="stamp">${escapeHtml(t("print.title"))}</span></p>`);
  body.push("<dl>");
  body.push(field(t("print.customer"), `<strong>${escapeHtml(customer.name)}</strong>`));
  body.push(field(t("print.code"), escapeHtml(customer.code), { num: true }));
  if (customer.areaName) body.push(field(t("print.area"), escapeHtml(customer.areaName)));
  if (customer.phone) body.push(field(t("print.phone"), escapeHtml(customer.phone), { num: true }));
  body.push(field(t("print.days"), escapeHtml(rangeText(range, t, locale))));
  body.push("</dl><hr>");

  const showOpening = range.from !== null || view.hiddenLines > 0;
  const openingDate = range.from ?? view.lines[0]?.date ?? range.to;
  const rows: string[] = [];
  if (showOpening) {
    rows.push(
      `<tr class="carry"><td class="num">${date(openingDate)}</td><td>${escapeHtml(
        t("summary.opening", { date: formatBusinessDate(openingDate, locale) }),
      )}</td><td></td><td class="balance num">${escapeHtml(
        balanceText(view.openingBalancePaise, t),
      )}</td></tr>`,
    );
  }
  for (const line of view.lines) {
    const words = describeLine(line, t, tb, locale);
    const extra = [...words.details];
    if (words.cancelledLater) extra.push(t("line.cancelled_later"));
    rows.push(
      `<tr><td class="num">${date(line.date)}</td><td class="what">${escapeHtml(words.title)}${
        extra.length > 0 ? `<small>${escapeHtml(extra.join(" · "))}</small>` : ""
      }</td><td class="amount num">${escapeHtml(signedRupees(line.amountPaise))}</td><td class="balance num">${escapeHtml(
        balanceText(line.balanceAfterPaise, t),
      )}</td></tr>`,
    );
  }
  if (view.lines.length === 0) {
    rows.push(
      `<tr><td colspan="4" class="center muted">${escapeHtml(t("print.nothing"))}</td></tr>`,
    );
  }
  body.push(
    `<table><thead><tr><th>${escapeHtml(t("print.col_date"))}</th><th>${escapeHtml(
      t("print.col_what"),
    )}</th><th class="amount">${escapeHtml(t("print.col_amount"))}</th><th class="balance">${escapeHtml(
      t("print.col_balance"),
    )}</th></tr></thead><tbody>${rows.join("")}</tbody></table><hr><dl>`,
  );
  body.push(
    field(t("summary.billed"), escapeHtml(signedRupees(totals.billedPaise)), { num: true }),
  );
  body.push(field(t("summary.paid"), escapeHtml(signedRupees(-totals.paidPaise)), { num: true }));
  if (totals.undonePaise > 0) {
    body.push(
      field(t("summary.undone"), escapeHtml(signedRupees(totals.undonePaise)), { num: true }),
    );
  }
  if (totals.discountPaise > 0) {
    body.push(
      field(t("summary.discount"), escapeHtml(signedRupees(-totals.discountPaise)), { num: true }),
    );
  }
  body.push(
    field(
      t("summary.closing", { date: formatBusinessDate(range.to, locale) }),
      escapeHtml(balanceText(view.closingBalancePaise, t)),
      { cls: "total", num: true },
    ),
  );
  body.push("</dl><hr>");
  body.push(
    `<p class="muted">${escapeHtml(
      t("print.printed_on", { date: formatBusinessDate(businessDateOf(view.generatedAt), locale) }),
    )} · ${escapeHtml(t("print.not_receipt"))}</p>`,
  );

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
    `<title>${escapeHtml(t("print.page_title", { name: customer.name }))}</title>`,
    `<style>${STATEMENT_PRINT_CSS}</style>`,
    "</head>",
    `<body><main>${body.join("")}</main><script>${script}</script></body>`,
    "</html>",
  ].join("");
}
