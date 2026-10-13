/**
 * Server-rendered HTML for the public receipt page and its generic pages. Plain strings with every
 * value escaped: no React runtime, no JavaScript at all, one small response (works with JS off and
 * on old phones). `noindex` is in the page as well as in the `X-Robots-Tag` header.
 */
import type { Locale } from "@cb/i18n";
import { ICON_NODES, ICON_SVG_ATTRIBUTES, type IconName } from "@cb/ui/icons-data";
import type { ReceiptDocument, ReceiptField } from "./content";
import { GENERIC_PAGE_LOCALES, type ReceiptTranslator, translatorFor } from "./i18n";
import { RECEIPT_PAGE_CSS } from "./style";

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

const SVG_ATTRIBUTE_NAMES: Record<string, string> = {
  strokeWidth: "stroke-width",
  strokeLinecap: "stroke-linecap",
  strokeLinejoin: "stroke-linejoin",
};

/** A decorative Lucide icon from the shared icon map (same meanings as the app, T-003). */
export function iconSvg(name: IconName, className = "icon"): string {
  const attributes = Object.entries(ICON_SVG_ATTRIBUTES)
    .map(([key, value]) => `${SVG_ATTRIBUTE_NAMES[key] ?? key}="${escapeHtml(String(value))}"`)
    .join(" ");
  const children = ICON_NODES[name]
    .map(
      ([tag, attrs]) =>
        `<${tag} ${Object.entries(attrs as Record<string, string>)
          .map(([key, value]) => `${key}="${escapeHtml(value)}"`)
          .join(" ")}/>`,
    )
    .join("");
  return `<svg class="${className}" aria-hidden="true" focusable="false" ${attributes}>${children}</svg>`;
}

function shell(lang: string, title: string, body: string): string {
  return [
    "<!doctype html>",
    `<html lang="${escapeHtml(lang)}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex,nofollow,noarchive">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="format-detection" content="telephone=no">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${RECEIPT_PAGE_CSS}</style>`,
    "</head>",
    `<body><main>${body}</main></body>`,
    "</html>",
  ].join("");
}

function fields(list: readonly ReceiptField[]): string {
  if (list.length === 0) return "";
  const rows = list
    .map(
      (field) =>
        `<div class="field"><dt>${escapeHtml(field.label)}</dt><dd${field.numeric ? ' class="num"' : ""}>${escapeHtml(field.value)}</dd></div>`,
    )
    .join("");
  return `<dl>${rows}</dl>`;
}

export interface ReceiptPageLinks {
  /** Same-origin path of the PDF (`/r/<token>/pdf?lang=…`). */
  readonly pdf: string;
  /** Same-origin path of the page in each language. */
  readonly languages: Readonly<Record<Locale, string>>;
}

/** The receipt page. */
export function receiptPageHtml(
  doc: ReceiptDocument,
  t: ReceiptTranslator,
  links: ReceiptPageLinks,
): string {
  const parts: string[] = [];
  parts.push('<div class="center stack">');
  parts.push(`<h1>${escapeHtml(doc.operatorName)}</h1>`);
  if (doc.operatorPhone) {
    parts.push(
      `<p><a class="call num" href="tel:${escapeHtml(doc.operatorPhone.dial)}">${iconSvg("call")}${escapeHtml(doc.operatorPhone.text)}</a></p>`,
    );
  }
  parts.push(`<h2>${escapeHtml(doc.heading)}</h2>`);
  if (doc.cancelled) {
    parts.push(
      `<p><span class="stamp" role="status">${escapeHtml(doc.cancelled.stamp)}</span></p>`,
    );
  }
  parts.push("</div><hr>");
  parts.push(fields(doc.receiptFields));
  if (doc.customerFields.length > 0) parts.push(`<hr>${fields(doc.customerFields)}`);
  parts.push("<hr>");
  parts.push('<div class="center stack">');
  parts.push(`<p class="amount num">${escapeHtml(doc.amount)}</p>`);
  parts.push(
    `<p class="method ${doc.method.kind}">${iconSvg(doc.method.kind)}${escapeHtml(doc.method.label)}</p>`,
  );
  parts.push("</div>");
  if (doc.cancelled) {
    parts.push(
      `<hr><p class="danger center">${iconSvg("danger")} ${escapeHtml(doc.cancelled.note)}</p>`,
    );
  } else if (doc.bills.length > 0 || doc.balance) {
    parts.push('<hr><div class="stack">');
    for (const bill of doc.bills) parts.push(`<p>${escapeHtml(bill)}</p>`);
    if (doc.balance) {
      const { tone, label, amount } = doc.balance;
      parts.push(
        amount === null
          ? `<p><strong>${escapeHtml(label)}</strong></p>`
          : `<div class="field"><span>${escapeHtml(label)}</span><strong class="num ${tone}">${escapeHtml(amount)}</strong></div>`,
      );
    }
    parts.push("</div>");
  }
  if (doc.footer) parts.push(`<hr><p class="center muted">${escapeHtml(doc.footer)}</p>`);

  const card = `<article class="card${doc.cancelled ? " cancelled" : ""}">${parts.join("")}</article>`;
  const download = `<a class="button" href="${escapeHtml(links.pdf)}" download>${iconSvg("export")}${escapeHtml(t("download_pdf"))}</a>`;
  const languages = (["hi", "en"] as const)
    .map((locale) => {
      const current = locale === doc.locale;
      return `<a href="${escapeHtml(links.languages[locale])}" hreflang="${locale}" lang="${locale}"${current ? ' aria-current="true"' : ""}>${escapeHtml(t(locale === "hi" ? "language_hi" : "language_en"))}</a>`;
    })
    .join("");
  return shell(
    doc.locale,
    doc.pageTitle,
    `${card}${download}<nav>${iconSvg("language")}${languages}</nav>`,
  );
}

export type GenericPageKind = "unavailable" | "rate_limited" | "error";

/**
 * The same page for every token that doesn't open a receipt (and for "too many tries" / errors):
 * both languages, nothing from the link, so it reveals nothing about whether a link existed.
 */
export function genericPageHtml(kind: GenericPageKind): string {
  const blocks = GENERIC_PAGE_LOCALES.map((locale) => {
    const t = translatorFor(locale);
    return `<section lang="${locale}" class="stack"><h1>${escapeHtml(t(`${kind}.title`))}</h1><p class="muted">${escapeHtml(t(`${kind}.body`))}</p></section>`;
  });
  const title = GENERIC_PAGE_LOCALES.map((locale) => translatorFor(locale)(`${kind}.title`)).join(
    " / ",
  );
  return shell(
    GENERIC_PAGE_LOCALES[0] ?? "hi",
    title,
    `<article class="card center">${iconSvg("danger", "icon-large danger")}${blocks.join("<hr>")}</article>`,
  );
}
