"use server";

/**
 * Team Server Actions (T-032). Next.js checks the Origin of every Server Action (CSRF); the session
 * gives the TenantContext (never an operator id from the client), and the core services enforce
 * Owner-only, read-only mode and tenant scope (another tenant's id → NOT_FOUND), validate and
 * audit. Passwords go straight to the service (hashed there) and are never logged or returned.
 */
import {
  addLineman,
  addStaff,
  deactivateMember,
  reactivateMember,
  resetMemberPassword,
  revokeDevice,
  SESSION_POLICY,
} from "@cb/core";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { loadShellData } from "@/components/shell/shell-data";
import { getAuthService, getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { type AddResult, type DoneResult, teamFailure } from "./action-state";
import { linemanShareUrl } from "./share-url";

const TEAM_PATH = "/settings/team";
/** Longest value taken from a field (well above every limit; stops huge posts early). */
const MAX_FIELD = 1_000;

const clip = (value: unknown): string =>
  typeof value === "string" ? value.slice(0, MAX_FIELD) : "";
const language = (value: unknown): "hi" | "en" | undefined =>
  value === "hi" || value === "en" ? value : undefined;

function failed(where: string, error: unknown): { ok: false; error: "unexpected" } {
  console.error(`team.${where}_failed`, error instanceof Error ? error.name : "unknown");
  return { ok: false, error: "unexpected" };
}

export interface AddLinemanFields {
  name: string;
  mobile: string;
  login: string;
  password: string;
  language: string;
}

export async function addLinemanAction(fields: AddLinemanFields): Promise<AddResult> {
  const ctx = await getTenantContext();
  try {
    const lang = language(fields.language);
    const result = await addLineman.call(getServerRuntime(), ctx, {
      name: clip(fields.name),
      mobile: clip(fields.mobile),
      login: clip(fields.login),
      password: clip(fields.password),
      ...(lang ? { language: lang } : {}),
    });
    if (!result.ok) return teamFailure(result.error);
    revalidatePath(TEAM_PATH);
    const added = result.value;
    const { operatorName } = await loadShellData(ctx);
    return {
      ok: true,
      added: {
        role: "lineman",
        name: added.name,
        login: added.login,
        suggestedLogin: added.loginChanged ? added.phone : null,
        shareUrl: await linemanShareUrl({
          business: operatorName,
          login: added.login,
          mobile: added.phone,
          language: added.language,
        }),
        invite: null,
      },
    };
  } catch (error) {
    return failed("add_lineman", error);
  }
}

export interface AddStaffFields {
  name: string;
  mobile: string;
  email: string;
  login: string;
  setup: string;
  password: string;
  language: string;
}

export async function addStaffAction(fields: AddStaffFields): Promise<AddResult> {
  const ctx = await getTenantContext();
  try {
    const setup = fields.setup === "invite" ? "invite" : "password";
    const lang = language(fields.language);
    const result = await addStaff.call(getServerRuntime(), ctx, {
      name: clip(fields.name),
      mobile: clip(fields.mobile),
      email: clip(fields.email),
      login: clip(fields.login),
      setup,
      ...(setup === "password" ? { password: clip(fields.password) } : {}),
      ...(lang ? { language: lang } : {}),
    });
    if (!result.ok) return teamFailure(result.error);
    revalidatePath(TEAM_PATH);
    const added = result.value;
    let invite: { email: string; queued: boolean; minutes: number } | null = null;
    if (added.invite && added.email) {
      // After the user is committed: the same single-use link as "Forgot password?", worded as
      // an invitation. Sending happens after the response (errors are logged, never shown).
      const { operatorName } = await loadShellData(ctx);
      const sent = await getAuthService().requestPasswordReset({
        email: added.email,
        headers: await headers(),
        invite: { businessName: operatorName, login: added.login },
      });
      invite = {
        email: added.email,
        queued: sent.ok,
        minutes: Math.round(SESSION_POLICY.resetTokenExpiresInSeconds / 60),
      };
    }
    return {
      ok: true,
      added: {
        role: "staff",
        name: added.name,
        login: added.login,
        suggestedLogin: added.loginChanged ? added.phone : null,
        shareUrl: null,
        invite,
      },
    };
  } catch (error) {
    return failed("add_staff", error);
  }
}

export async function resetPasswordAction(userId: string, password: string): Promise<DoneResult> {
  const ctx = await getTenantContext();
  try {
    const result = await resetMemberPassword.call(getServerRuntime(), ctx, {
      userId: clip(userId),
      password: clip(password),
    });
    if (!result.ok) return teamFailure(result.error);
    revalidatePath(TEAM_PATH);
    return { ok: true };
  } catch (error) {
    return failed("reset_password", error);
  }
}

export async function switchOffAction(userId: string): Promise<DoneResult> {
  const ctx = await getTenantContext();
  try {
    const result = await deactivateMember.call(getServerRuntime(), ctx, { userId: clip(userId) });
    if (!result.ok) return teamFailure(result.error);
    revalidatePath(TEAM_PATH);
    return { ok: true };
  } catch (error) {
    return failed("switch_off", error);
  }
}

export async function switchOnAction(userId: string): Promise<DoneResult> {
  const ctx = await getTenantContext();
  try {
    const result = await reactivateMember.call(getServerRuntime(), ctx, { userId: clip(userId) });
    if (!result.ok) return teamFailure(result.error);
    revalidatePath(TEAM_PATH);
    return { ok: true };
  } catch (error) {
    return failed("switch_on", error);
  }
}

export async function signOutPhoneAction(deviceId: string): Promise<DoneResult> {
  const ctx = await getTenantContext();
  try {
    const result = await revokeDevice.call(getServerRuntime(), ctx, { deviceId: clip(deviceId) });
    if (!result.ok) return teamFailure(result.error);
    revalidatePath(TEAM_PATH);
    return { ok: true };
  } catch (error) {
    return failed("sign_out_phone", error);
  }
}
