"use server";

/**
 * Accept / Send back Server Actions (T-062). Next.js checks the Origin of every Server Action
 * (CSRF); `getTenantContext()` is the sign-in gate; the services check the capability
 * (`handover.review`), the tenant (another tenant's session → NOT_FOUND) and read-only mode.
 * The office decides on the submission it looked at, so a newer handover is never accepted blind.
 */
import { acceptHandover, returnHandover } from "@cb/core";
import { revalidatePath } from "next/cache";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { type ReviewActionResult, reviewErrorKey } from "../_lib/review-result";

export interface ReviewInput {
  readonly sessionId: string;
  readonly submissionId: string;
  readonly note?: string;
}

function done(
  result: Awaited<ReturnType<typeof acceptHandover.call>>,
  status: "accepted" | "returned",
): ReviewActionResult {
  if (result.ok) {
    revalidatePath("/linemen", "layout");
    return { ok: true, status };
  }
  if (result.error.code === "INTERNAL") {
    console.error("linemen.review_failed", result.error.code);
  }
  return { ok: false, error: reviewErrorKey(result.error) };
}

export async function acceptHandoverAction(input: ReviewInput): Promise<ReviewActionResult> {
  const ctx = await getTenantContext();
  const result = await acceptHandover.call(getServerRuntime(), ctx, {
    sessionId: input.sessionId,
    submissionId: input.submissionId,
  });
  return done(result, "accepted");
}

export async function returnHandoverAction(input: ReviewInput): Promise<ReviewActionResult> {
  const ctx = await getTenantContext();
  const result = await returnHandover.call(getServerRuntime(), ctx, {
    sessionId: input.sessionId,
    submissionId: input.submissionId,
    note: input.note ?? "",
  });
  return done(result, "returned");
}
