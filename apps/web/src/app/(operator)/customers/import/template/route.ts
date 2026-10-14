/**
 * `GET /customers/import/template?format=xlsx|csv&lang=en|hi`: the empty import form (T-084).
 * Column names in the page's language unless `lang` asks for the other one ("Hindi headers
 * optional"). Owner/Staff only (404 for others, like the page); nothing about the business is in it.
 */
import { buildImportTemplate, IMPORT_CONTENT_TYPES } from "@cb/core";
import { isLocale } from "@/i18n/config";
import {
  attachment,
  importContext,
  importWords,
  PRIVATE_HEADERS,
  templateWords,
} from "../_lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!(await importContext())) return new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const kind = url.searchParams.get("format") === "csv" ? "csv" : "xlsx";
  const lang = url.searchParams.get("lang");
  const t = await importWords(isLocale(lang) ? lang : undefined);
  const bytes = buildImportTemplate(kind, templateWords(t));
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      ...PRIVATE_HEADERS,
      "Content-Type": IMPORT_CONTENT_TYPES[kind],
      "Content-Disposition": attachment(t("template.file_name"), kind, "customers-form"),
    },
  });
}
