/**
 * Settings → Business details (T-030, PLAN §12.1): name, office phone, address, receipt message,
 * bill number start, receipt language and the mid-month start policy (D-18).
 *
 * Owner: the form. Staff (and the Owner while the tenant is read-only): the same values,
 * read-only. The service decides which (`editable`); saving is checked again on the server
 * (Owner only, not in read-only mode), so the hidden form is not the guard.
 */
import { formatInvoiceNumber, getBusinessProfile } from "@cb/core";
import { periodOfInstant } from "@cb/domain";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { roleCan } from "@/components/shell/access";
import { placeholderMetadata } from "@/components/shell/placeholder-page";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { canSeeRoute } from "@/lib/nav";
import { saveProfileAction } from "./actions";
import { profileValuesOf } from "./form-state";
import { ProfileForm } from "./profile-form";
import { ProfileView } from "./profile-view";

export const generateMetadata = () => placeholderMetadata("settings_profile");

export default async function BusinessProfilePage() {
  const ctx = await getTenantContext();
  if (!canSeeRoute("settings_profile", roleCan(ctx.role))) notFound();
  const runtime = getServerRuntime();
  const result = await getBusinessProfile.call(runtime, ctx, {});
  if (!result.ok) throw new Error(`operators.get_profile failed: ${result.error.code}`);
  const { profile, editable, readOnlyReason } = result.value;
  const title = (await getTranslations("shell"))("routes.settings_profile");

  if (!editable) {
    return <ProfileView title={title} profile={profile} reason={readOnlyReason ?? "not_owner"} />;
  }
  return (
    <ProfileForm
      title={title}
      initial={profileValuesOf(profile)}
      exampleSuffix={formatInvoiceNumber("", periodOfInstant(runtime.now()), 1)}
      action={saveProfileAction}
    />
  );
}
