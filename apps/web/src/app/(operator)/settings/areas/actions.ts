"use server";

/**
 * Area Server Actions (T-030). The TenantContext comes from the session; the area id comes from
 * the page and is only ever looked up inside the caller's tenant (another tenant's id is
 * NOT_FOUND). The core services enforce Owner-only and read-only mode, validate and audit.
 */
import { type AnyService, archiveArea, createArea, renameArea, restoreArea } from "@cb/core";
import { revalidatePath } from "next/cache";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { type AreaActionResult, areaErrorKey } from "./action-state";

const AREAS_PATH = "/settings/areas";

async function run(service: AnyService, input: unknown): Promise<AreaActionResult> {
  const ctx = await getTenantContext();
  try {
    const result = await service.call(getServerRuntime(), ctx, input);
    if (!result.ok) {
      // A stale list (someone else changed it) is fixed by showing the fresh one.
      if (result.error.code === "NOT_FOUND") revalidatePath(AREAS_PATH);
      return { ok: false, error: areaErrorKey(result.error) };
    }
    revalidatePath(AREAS_PATH);
    return { ok: true };
  } catch (error) {
    console.error("settings.area_action_failed", error instanceof Error ? error.name : "unknown");
    return { ok: false, error: "unexpected" };
  }
}

export async function createAreaAction(name: string): Promise<AreaActionResult> {
  return run(createArea, { name });
}

export async function renameAreaAction(areaId: string, name: string): Promise<AreaActionResult> {
  return run(renameArea, { areaId, name });
}

export async function archiveAreaAction(areaId: string): Promise<AreaActionResult> {
  return run(archiveArea, { areaId });
}

export async function restoreAreaAction(areaId: string): Promise<AreaActionResult> {
  return run(restoreArea, { areaId });
}
