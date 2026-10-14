"use server";

/**
 * "Try again" for a failed background job (T-086). `getAdminContext()` is the gate; the service
 * enqueues a new copy of the failed job (the failed row stays as history) and writes the admin log.
 */
import { retryJob } from "@cb/core";
import { redirect } from "next/navigation";
import { getServerRuntime } from "@/lib/auth/server";
import { getAdminContext } from "../_lib/context";

export async function retryJobAction(form: FormData): Promise<void> {
  const ctx = await getAdminContext();
  const result = await retryJob.call(getServerRuntime(), ctx, {
    jobId: String(form.get("jobId") ?? ""),
  });
  if (result.ok) redirect("/admin/jobs?status=failed&done=retried");
  const reason = result.error.details?.reason;
  const error =
    reason === "already_queued" || reason === "not_failed"
      ? reason
      : result.error.code === "NOT_FOUND"
        ? "not_found"
        : "generic";
  if (error === "generic") console.error("admin.job_retry_failed", result.error.code);
  redirect(`/admin/jobs?status=failed&error=${error}`);
}
