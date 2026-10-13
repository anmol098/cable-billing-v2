/**
 * Public pages (T-087): `/`, `/pricing`, `/privacy`, `/terms`, `/contact`. Server components with no
 * client code of their own; plain links and a plain-form language switch.
 *
 * `/` always shows the landing page, signed in or not: the cookie check below only changes the
 * header's word ("Open app" instead of "Sign in"). Both go to `/login`, which sends a signed-in
 * user on to their own home (`/home` or `/admin`, T-026), so no database call happens here.
 */
import { cookies } from "next/headers";
import { getLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { setLocale } from "@/i18n/actions";
import { SESSION_COOKIE_NAMES } from "@/lib/auth/paths";
import { MarketingFrame } from "./_components/frame";

export default async function MarketingLayout({ children }: { children: ReactNode }) {
  const [cookieStore, locale] = await Promise.all([cookies(), getLocale()]);
  const signedIn = SESSION_COOKIE_NAMES.some((name) => cookieStore.has(name));
  return (
    <MarketingFrame signedIn={signedIn} locale={locale} localeAction={setLocale}>
      {children}
    </MarketingFrame>
  );
}
