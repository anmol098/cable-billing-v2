"use server";

/**
 * Business profile Server Action (T-030). Next.js checks the Origin of every Server Action (CSRF);
 * the session gives the TenantContext (never an operator id from the form), and the core service
 * enforces Owner-only and read-only mode, validates and audits.
 */
import { type UpdateBusinessProfileCommand, updateBusinessProfile } from "@cb/core";
import { revalidatePath } from "next/cache";
import { field } from "@/app/(auth)/login/_components/form-state";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import {
  PROFILE_FIELDS,
  type ProfileFormState,
  type ProfileValues,
  profileFormStateFor,
  profileValuesOf,
} from "./form-state";

/** Longest value kept from a form field (well above every limit; stops huge posts early). */
const MAX_FIELD = 2_000;

export async function saveProfileAction(
  _previous: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const ctx = await getTenantContext();
  const values = Object.fromEntries(
    PROFILE_FIELDS.map((name) => [name, field(formData, name).slice(0, MAX_FIELD)]),
  ) as ProfileValues;
  try {
    // Untrusted text: the service validates every field (enums included) before using it.
    const input = values as UpdateBusinessProfileCommand;
    const result = await updateBusinessProfile.call(getServerRuntime(), ctx, input);
    if (!result.ok) return profileFormStateFor(result.error, values);
    // The business name is in the shell header on every page.
    if (result.value.changed.length > 0) revalidatePath("/", "layout");
    return {
      saved: {
        changed: result.value.changed.length,
        at: Date.now(),
        values: profileValuesOf(result.value.profile),
      },
    };
  } catch (error) {
    console.error("settings.profile_save_failed", error instanceof Error ? error.name : "unknown");
    return { error: "unexpected", values };
  }
}
