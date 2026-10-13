/**
 * Settings → Areas (T-030, PLAN §12.1): the parts of town the linemen cover. Owner: add, change
 * name, hide (archive) and show again; there is no delete (see packages/core/src/areas). Staff
 * (and the Owner while the tenant is read-only): the list only. The services re-check every
 * change (Owner only, not in read-only mode, tenant-scoped ids).
 */
import { listAreas } from "@cb/core";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { roleCan } from "@/components/shell/access";
import { placeholderMetadata } from "@/components/shell/placeholder-page";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { canSeeRoute } from "@/lib/nav";
import {
  archiveAreaAction,
  createAreaAction,
  renameAreaAction,
  restoreAreaAction,
} from "./actions";
import { AreasManager } from "./areas-manager";

export const generateMetadata = () => placeholderMetadata("settings_areas");

export default async function AreasPage() {
  const ctx = await getTenantContext();
  if (!canSeeRoute("settings_areas", roleCan(ctx.role))) notFound();
  const result = await listAreas.call(getServerRuntime(), ctx, {});
  if (!result.ok) throw new Error(`areas.list failed: ${result.error.code}`);
  const { areas, editable, readOnlyReason } = result.value;
  const title = (await getTranslations("shell"))("routes.settings_areas");
  return (
    <AreasManager
      title={title}
      areas={areas.map(({ archivedAt, ...area }) => ({ ...area, hidden: archivedAt !== null }))}
      editable={editable}
      readOnlyReason={readOnlyReason}
      actions={{
        create: createAreaAction,
        rename: renameAreaAction,
        archive: archiveAreaAction,
        restore: restoreAreaAction,
      }}
    />
  );
}
