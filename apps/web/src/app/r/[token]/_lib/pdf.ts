/**
 * A5 PDF of the public receipt (FR-019 "PDF receipt", PLAN §9.4): the same lines as the page
 * (`receiptDocument`), drawn with PDFKit on the server (pure JavaScript, works on Vercel's Node
 * runtime; Next.js keeps it out of the bundle via `serverExternalPackages` defaults).
 *
 * Text uses **Noto Sans Devanagari** (Regular + SemiBold, OFL; it also has Latin and ₹), bundled
 * next to this file (the same files as the Android printer, T-068) and read from disk: never
 * fetched from the network. PDFKit shapes Devanagari with fontkit (conjuncts, matras, reph) and
 * embeds only the glyphs used, so a receipt PDF is small.
 *
 * Colours, type sizes, spacing and border widths come from the design tokens (1 token px = 1 pt).
 */
import { readFile } from "node:fs/promises";
import tokens from "@cb/design-tokens/tokens.json";
import PDFDocument from "pdfkit";
import type { ReceiptDocument, ReceiptField } from "./content";

/** A5 portrait in PDF points (148 × 210 mm). */
const A5: [number, number] = [419.53, 595.28];
const unit = tokens.space.base;
const MARGIN = unit * 10;
const type = tokens.type.web;
const color = Object.fromEntries(
  Object.entries({ ...tokens.color, ...tokens.semantic }).map(([name, token]) => [
    name,
    token.value,
  ]),
) as Record<keyof typeof tokens.color | keyof typeof tokens.semantic, string>;
const LINE_GAP = unit / 2;

let fonts: Promise<{ regular: Buffer; strong: Buffer }> | undefined;

/** The bundled fonts, read once per server instance. */
function loadFonts() {
  fonts ??= Promise.all([
    readFile(new URL("./fonts/NotoSansDevanagari-Regular.ttf", import.meta.url)),
    readFile(new URL("./fonts/NotoSansDevanagari-SemiBold.ttf", import.meta.url)),
  ]).then(([regular, strong]) => ({ regular, strong }));
  return fonts;
}

/** `R-2610-00045` → `receipt-R-2610-00045.pdf` (ASCII only, safe in a header). */
export function pdfFileName(receiptNumber: string): string {
  return `receipt-${receiptNumber.replace(/[^A-Za-z0-9-]/g, "_")}.pdf`;
}

export async function receiptPdf(doc: ReceiptDocument, createdAt: Date): Promise<Buffer> {
  const { regular, strong } = await loadFonts();
  const pdf = new PDFDocument({
    size: A5,
    margin: MARGIN,
    lang: doc.locale === "hi" ? "hi-IN" : "en-IN",
    info: {
      Title: doc.pageTitle,
      Creator: "Cable Billing",
      Producer: "Cable Billing",
      CreationDate: createdAt,
    },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });

  pdf.registerFont("regular", regular);
  pdf.registerFont("strong", strong);
  const left = MARGIN;
  const width = A5[0] - MARGIN * 2;

  const text = (
    value: string,
    options: {
      font?: "regular" | "strong";
      size?: number;
      fill?: string;
      align?: "left" | "center";
    } = {},
  ) => {
    pdf
      .font(options.font ?? "regular")
      .fontSize(options.size ?? type.base)
      .fillColor(options.fill ?? color.text)
      .text(value, left, pdf.y, { width, align: options.align ?? "left", lineGap: LINE_GAP });
  };
  const gap = (steps = 2) => {
    pdf.y += unit * steps;
  };
  const rule = () => {
    gap(3);
    pdf
      .moveTo(left, pdf.y)
      .lineTo(left + width, pdf.y)
      .lineWidth(tokens.border.hairline)
      .strokeColor(color.border)
      .stroke();
    gap(3);
  };
  const field = (item: ReceiptField, valueFill: string = color.text) => {
    const y = pdf.y;
    pdf.font("regular").fontSize(type.base);
    const labelHeight = pdf.heightOfString(item.label, { width: width / 2 });
    pdf
      .fillColor(color.textMuted)
      .text(item.label, left, y, { width: width / 2, lineGap: LINE_GAP });
    pdf.font("strong");
    const valueHeight = pdf.heightOfString(item.value, { width: width / 2 });
    pdf.fillColor(valueFill).text(item.value, left + width / 2, y, {
      width: width / 2,
      align: "right",
      lineGap: LINE_GAP,
    });
    pdf.y = y + Math.max(labelHeight, valueHeight) + unit;
  };

  text(doc.operatorName, { font: "strong", size: type.xl, align: "center" });
  if (doc.operatorPhone) text(doc.operatorPhone.text, { align: "center" });
  gap();
  text(doc.heading, { font: "strong", size: type.lg, align: "center" });
  if (doc.cancelled) {
    gap();
    pdf.font("strong").fontSize(type.xl);
    const stampWidth = pdf.widthOfString(doc.cancelled.stamp) + unit * 8;
    const stampHeight = pdf.currentLineHeight(true) + unit * 2;
    const x = left + (width - stampWidth) / 2;
    const y = pdf.y;
    pdf
      .roundedRect(x, y, stampWidth, stampHeight, tokens.radius.md)
      .lineWidth(tokens.border.strong)
      .strokeColor(color.danger)
      .stroke();
    pdf
      .fillColor(color.danger)
      .text(doc.cancelled.stamp, x, y + unit, { width: stampWidth, align: "center" });
    pdf.y = y + stampHeight;
  }
  rule();
  for (const item of doc.receiptFields) field(item);
  if (doc.customerFields.length > 0) {
    rule();
    for (const item of doc.customerFields) field(item);
  }
  rule();
  text(doc.amount, { font: "strong", size: type.amount, align: "center" });
  text(doc.method.label, {
    font: "strong",
    size: type.lg,
    fill: doc.method.kind === "cash" ? color.cash : color.upi,
    align: "center",
  });
  if (doc.cancelled) {
    rule();
    text(doc.cancelled.note, { fill: color.danger, align: "center" });
  } else if (doc.bills.length > 0 || doc.balance) {
    rule();
    for (const bill of doc.bills) text(bill);
    if (doc.balance) {
      gap(1);
      const { tone, label, amount } = doc.balance;
      if (amount === null) text(label, { font: "strong" });
      else field({ label, value: amount }, tone === "due" ? color.due : color.credit);
    }
  }
  if (doc.footer) {
    rule();
    text(doc.footer, { fill: color.textMuted, align: "center" });
  }
  pdf.end();
  return done;
}
