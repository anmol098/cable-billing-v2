/**
 * Settings → Staff and linemen (T-032, PLAN §9.3, §11.6, §12.3). Owner only: Staff get a 404 here
 * (as for the placeholder) and FORBIDDEN from every team service, so hiding the page is not the
 * guard. Lists linemen (with their phones) and staff; adds people, sets a new password, switches
 * people off and on, shares a lineman's sign-in on WhatsApp and signs a lost phone out.
 */
import { randomInt } from "node:crypto";
import {
  LINEMAN_PASSWORD_MIN_LENGTH,
  listTeam,
  STAFF_PASSWORD_MIN_LENGTH,
  suggestLinemanPassword,
  type TeamMemberView,
} from "@cb/core";
import { businessDateOf, type DisplayLocale } from "@cb/domain";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { roleCan } from "@/components/shell/access";
import { placeholderMetadata } from "@/components/shell/placeholder-page";
import { loadShellData } from "@/components/shell/shell-data";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { canSeeRoute } from "@/lib/nav";
import {
  addLinemanAction,
  addStaffAction,
  resetPasswordAction,
  signOutPhoneAction,
  switchOffAction,
  switchOnAction,
} from "./actions";
import { memberRow } from "./rows";
import type { Translate } from "./share";
import { linemanShareUrl } from "./share-url";
import { TeamManager } from "./team-manager";

export const generateMetadata = () => placeholderMetadata("settings_team");

type ManagedMember = TeamMemberView & { readonly role: "staff" | "lineman" };

export default async function TeamPage() {
  const ctx = await getTenantContext();
  if (!canSeeRoute("settings_team", roleCan(ctx.role))) notFound();
  const runtime = getServerRuntime();
  const result = await listTeam.call(runtime, ctx, {});
  if (!result.ok) throw new Error(`team.list failed: ${result.error.code}`);
  const { members, editable, readOnlyReason } = result.value;

  const locale = (await getLocale()) as DisplayLocale;
  // Plain (key, values) → string translators for the pure row builders (as T-062 does).
  const t = (await getTranslations("team")) as unknown as Translate;
  const linemenT = (await getTranslations("linemen")) as unknown as Translate;
  const title = (await getTranslations("shell"))("routes.settings_team");
  const { operatorName } = await loadShellData(ctx);
  const today = businessDateOf(runtime.now());

  const managed = members.filter((m): m is ManagedMember => m.role !== "owner");
  const rows = await Promise.all(
    managed.map(async (member) =>
      memberRow(
        t,
        linemenT,
        member,
        member.role === "lineman"
          ? await linemanShareUrl({
              business: operatorName,
              login: member.login,
              mobile: member.phone,
              language: member.language,
            })
          : null,
        today,
        locale,
      ),
    ),
  );

  return (
    <TeamManager
      title={title}
      linemen={rows.filter((row) => row.role === "lineman")}
      staff={rows.filter((row) => row.role === "staff")}
      editable={editable}
      readOnly={readOnlyReason === "tenant_read_only"}
      rules={{ linemanMin: LINEMAN_PASSWORD_MIN_LENGTH, staffMin: STAFF_PASSWORD_MIN_LENGTH }}
      suggestedPassword={suggestLinemanPassword((n) => randomInt(n))}
      actions={{
        addLineman: addLinemanAction,
        addStaff: addStaffAction,
        resetPassword: resetPasswordAction,
        switchOff: switchOffAction,
        switchOn: switchOnAction,
        signOutPhone: signOutPhoneAction,
      }}
    />
  );
}
