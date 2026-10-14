/**
 * Settings → Plans (T-031, FR-007, PLAN §9.3): the monthly rents the business charges. Owner: add,
 * change name or rent, hide (retire) and show again; there is no delete (see
 * packages/core/src/plans). Staff (and the Owner while the tenant is read-only): the list only.
 * The services re-check every change (Owner only, not in read-only mode, tenant-scoped ids).
 */
import { listPlans } from "@cb/core";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { roleCan } from "@/components/shell/access";
import { placeholderMetadata } from "@/components/shell/placeholder-page";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { canSeeRoute } from "@/lib/nav";
import { createPlanAction, restorePlanAction, retirePlanAction, updatePlanAction } from "./actions";
import { PlansManager } from "./plans-manager";

export const generateMetadata = () => placeholderMetadata("settings_plans");

export default async function PlansPage() {
  const ctx = await getTenantContext();
  if (!canSeeRoute("settings_plans", roleCan(ctx.role))) notFound();
  const result = await listPlans.call(getServerRuntime(), ctx, {});
  if (!result.ok) throw new Error(`plans.list failed: ${result.error.code}`);
  const { plans, editable, readOnlyReason } = result.value;
  const title = (await getTranslations("shell"))("routes.settings_plans");
  return (
    <PlansManager
      title={title}
      plans={plans}
      editable={editable}
      readOnlyReason={readOnlyReason}
      actions={{
        create: createPlanAction,
        update: updatePlanAction,
        retire: retirePlanAction,
        restore: restorePlanAction,
      }}
    />
  );
}
