/**
 * `POST /customers/import/check` (multipart, field `file`): reads the uploaded file and previews
 * it (`imports.customers.check`), T-084. A route, not a Server Action, because a 5,000-line file
 * can be larger than Next.js' 1 MB Server Action body limit; the limit here is
 * `IMPORT_LIMITS.fileBytes` (under Vercel's 4.5 MB request limit).
 *
 * Owner/Staff only; a POST must come from our own page (`Origin`). The file is read in memory and
 * never stored; nothing from it is logged (only error codes).
 */
import { checkCustomerImport, IMPORT_LIMITS, readImportFile } from "@cb/core";
import { getServerRuntime } from "@/lib/auth/server";
import { importContext, isSameOrigin, jsonResponse } from "../_lib/server";
import type { CheckError, CheckResponse } from "../_lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Room for the multipart envelope around the file. */
const ENVELOPE_BYTES = 64 * 1024;

function failure(error: CheckError, status: number): Response {
  const body: CheckResponse = { ok: false, error };
  return jsonResponse(body, status);
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return failure({ code: "not_allowed" }, 403);
  const ctx = await importContext();
  if (!ctx) return failure({ code: "not_allowed" }, 403);

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > IMPORT_LIMITS.fileBytes + ENVELOPE_BYTES) return failure({ code: "too_big" }, 413);
  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get("file");
  } catch {
    return failure({ code: "no_file" }, 400);
  }
  if (!(file instanceof File) || file.name === "") return failure({ code: "no_file" }, 400);
  if (file.size > IMPORT_LIMITS.fileBytes) return failure({ code: "too_big" }, 413);

  const read = readImportFile(new Uint8Array(await file.arrayBuffer()));
  if (!read.ok) return failure(read.error, 422);

  const result = await checkCustomerImport.call(getServerRuntime(), ctx, {
    lines: [...read.value.lines],
  });
  if (!result.ok) {
    if (result.error.code === "TENANT_READ_ONLY") return failure({ code: "read_only" }, 409);
    if (result.error.code === "FORBIDDEN") return failure({ code: "not_allowed" }, 403);
    console.error("customers.import_check_failed", result.error.code);
    return failure({ code: "unexpected" }, 500);
  }
  const body: CheckResponse = {
    ok: true,
    file: {
      name: file.name.slice(0, 120),
      format: read.value.format,
      warnings: read.value.warnings,
      unusedColumns: read.value.unusedColumns.slice(0, 20),
    },
    lines: read.value.lines,
    preview: result.value,
  };
  return jsonResponse(body);
}
