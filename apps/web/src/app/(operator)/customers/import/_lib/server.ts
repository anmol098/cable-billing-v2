/**
 * Server only. Shared pieces of the import routes (T-084): who may use them, the same-origin check
 * for POSTs, file responses, and the words for the generated files.
 */
import {
  can,
  type ImportField,
  type ImportFileKind,
  type ImportTemplateWords,
  type ProblemFileWords,
  type TenantContext,
} from "@cb/core";
import type { Locale } from "@cb/i18n";
import { getTranslations } from "next-intl/server";
import { getTenantContext } from "@/lib/auth/session";
import { FIELD_KEY, FIELDS, type ImportWords } from "./words";

export const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

/** The signed-in Owner/Staff who may import (`customers.manage`), or `null`. */
export async function importContext(): Promise<TenantContext | null> {
  const ctx = await getTenantContext();
  return can(ctx.role, "customers.manage") ? ctx : null;
}

/**
 * A POST from our own pages: the browser's `Origin` must name this host (the session cookie alone
 * is not proof, PLAN §9 CSRF). Server Actions get the same check from Next.js.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return host !== null && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: PRIVATE_HEADERS });
}

const ASCII_NAME = /^[A-Za-z0-9._-]+$/;

/** `Content-Disposition` for a download; a non-ASCII name goes in `filename*` (RFC 6266). */
export function attachment(name: string, kind: ImportFileKind, fallback: string): string {
  const file = `${name}.${kind}`;
  const ascii = ASCII_NAME.test(name) ? file : `${fallback}.${kind}`;
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file)}`;
}

/** The `import` namespace in a given language, with string keys. */
export async function importWords(locale?: Locale): Promise<ImportWords> {
  const t = locale
    ? await getTranslations({ locale, namespace: "import" })
    : await getTranslations("import");
  return t as unknown as ImportWords;
}

function headers(t: ImportWords): Record<ImportField, string> {
  return Object.fromEntries(
    FIELDS.map((field) => [field, t(`template.columns.${FIELD_KEY[field]}`)]),
  ) as Record<ImportField, string>;
}

const HELP_KEYS = ["title", "line", "needed", "phone", "area", "plan", "date", "again", "example"];

export function templateWords(t: ImportWords): ImportTemplateWords {
  return {
    sheetName: t("template.sheet"),
    headers: headers(t),
    helpSheetName: t("template.help_sheet"),
    helpLines: HELP_KEYS.map((key) => t(`template.help.${key}`)),
  };
}

export function problemFileWords(t: ImportWords): ProblemFileWords {
  return {
    sheetName: t("problem_file.sheet"),
    headers: headers(t),
    line: t("problem_file.line"),
    problem: t("problem_file.problem"),
  };
}
