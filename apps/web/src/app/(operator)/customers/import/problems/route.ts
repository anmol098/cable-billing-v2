/**
 * `POST /customers/import/problems` (JSON `{ kind, lines: [{ line, values, problems }] }`): the
 * "lines with problems" file (T-084), in the page's language: Line, Problem (in words) and the
 * line's cells, ready to fix and upload again (the import ignores Line and Problem).
 *
 * The cells come back from the page that got them from `/check`; this route only lays them out.
 * CSV cells are protected against formula injection, .xlsx cells are text cells (core
 * `buildProblemFile`). A route rather than a Server Action because 5,000 lines can pass 1 MB.
 */
import {
  buildProblemFile,
  IMPORT_CONTENT_TYPES,
  IMPORT_FIELDS,
  IMPORT_LIMITS,
  type ImportField,
  type LineProblem,
} from "@cb/core";
import type { DisplayLocale } from "@cb/domain";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import {
  attachment,
  importContext,
  importWords,
  isSameOrigin,
  jsonResponse,
  PRIVATE_HEADERS,
  problemFileWords,
} from "../_lib/server";
import { problemsText } from "../_lib/words";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

const text = z.string().max(IMPORT_LIMITS.cellChars).default("");
const Body = z.object({
  kind: z.enum(["xlsx", "csv"]),
  lines: z
    .array(
      z.object({
        line: z.number().int().min(1).max(1_048_576),
        values: z.object(
          Object.fromEntries(IMPORT_FIELDS.map((field) => [field, text])) as Record<
            ImportField,
            typeof text
          >,
        ),
        problems: z
          .array(
            z.object({
              field: z.enum([...IMPORT_FIELDS, "line"]),
              code: z.string().regex(/^[a-z_]{1,40}$/),
              params: z.record(z.string(), z.union([z.string().max(200), z.number()])).optional(),
            }),
          )
          .max(20),
      }),
    )
    .min(1)
    .max(IMPORT_LIMITS.rows),
});

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return jsonResponse({ ok: false }, 403);
  if (!(await importContext())) return jsonResponse({ ok: false }, 403);
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return jsonResponse({ ok: false }, 413);
  }
  let parsed: z.infer<typeof Body>;
  try {
    const body = Body.safeParse(await request.json());
    if (!body.success) return jsonResponse({ ok: false }, 400);
    parsed = body.data;
  } catch {
    return jsonResponse({ ok: false }, 400);
  }
  const [t, locale] = await Promise.all([importWords(), getLocale()]);
  const rows = [...parsed.lines]
    .sort((a, b) => a.line - b.line)
    .map((line) => ({
      line: line.line,
      values: line.values,
      problem: problemsText(t, line.problems as LineProblem[], locale as DisplayLocale),
    }));
  const bytes = buildProblemFile(parsed.kind, problemFileWords(t), rows);
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      ...PRIVATE_HEADERS,
      "Content-Type": IMPORT_CONTENT_TYPES[parsed.kind],
      "Content-Disposition": attachment(
        t("problem_file.file_name"),
        parsed.kind,
        "customers-problems",
      ),
    },
  });
}
