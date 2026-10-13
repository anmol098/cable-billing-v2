"use server";

/**
 * Sign-out Server Actions for the app shell (T-029's account menu, T-086's admin header):
 * `<form action={signOutAction}><Button type="submit" icon="logout">…</Button></form>`.
 * Both work without client JavaScript and end on the login page.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuthService } from "./server";

/** Ends this browser's session. */
export async function signOutAction(): Promise<void> {
  await getAuthService().signOut({ headers: await headers() });
  redirect("/login?notice=signed_out");
}

/** Ends every session of the signed-in user (all browsers and devices). */
export async function signOutEverywhereAction(): Promise<void> {
  await getAuthService().signOutEverywhere({ headers: await headers() });
  redirect("/login?notice=signed_out");
}
