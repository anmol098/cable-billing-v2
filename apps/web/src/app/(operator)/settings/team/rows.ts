/**
 * The team list as the client component receives it (T-032): plain strings and booleans, every
 * date already formatted in IST by the server. Pure: the translators are passed in.
 */
import type { TeamMemberView, TeamPhoneView } from "@cb/core";
import type { BusinessDate, DisplayLocale } from "@cb/domain";
import { type Translate as LinemenTranslate, whenText } from "../../linemen/_lib/format";
import type { Translate } from "./share";

export interface PhoneRow {
  readonly id: string;
  /** "Xiaomi Redmi 9A (ABC)". */
  readonly label: string;
  /** "App 1.0.3", or null when unknown. */
  readonly appVersion: string | null;
  /** "Phone last online 4:05 PM" / "… 12 Oct 2026, 4:05 PM" / "Not online yet". */
  readonly lastOnline: string;
  readonly signedIn: boolean;
  /** The Owner signed this phone out (no button then). */
  readonly signedOut: boolean;
}

export interface MemberRow {
  readonly id: string;
  readonly role: "staff" | "lineman";
  readonly name: string;
  readonly login: string;
  /** Grouped for reading: "98765 43210". */
  readonly mobile: string | null;
  readonly email: string | null;
  readonly active: boolean;
  readonly passwordSet: boolean;
  /** Linemen: the WhatsApp link (never the password). */
  readonly shareUrl: string | null;
  readonly phones: readonly PhoneRow[];
}

/** `9876543210` → `98765 43210` (easier to read aloud); anything else unchanged. */
export function groupMobile(phone: string | null): string | null {
  if (!phone) return null;
  return /^\d{10}$/.test(phone) ? `${phone.slice(0, 5)} ${phone.slice(5)}` : phone;
}

export function phoneRow(
  t: Translate,
  linemenT: LinemenTranslate,
  phone: TeamPhoneView,
  today: BusinessDate,
  locale: DisplayLocale,
): PhoneRow {
  const model = phone.model?.trim() || t("phones.unknown_model");
  return {
    id: phone.id,
    label: t("phones.name", { model, code: phone.deviceCode }),
    appVersion: phone.appVersion ? t("phones.app_version", { version: phone.appVersion }) : null,
    lastOnline: phone.lastSeenAt
      ? t("phones.last_online", { when: whenText(linemenT, phone.lastSeenAt, today, locale) })
      : t("phones.never_online"),
    signedIn: phone.signedIn,
    signedOut: phone.signedOutAt !== null,
  };
}

export function memberRow(
  t: Translate,
  linemenT: LinemenTranslate,
  member: TeamMemberView & { readonly role: "staff" | "lineman" },
  shareUrl: string | null,
  today: BusinessDate,
  locale: DisplayLocale,
): MemberRow {
  return {
    id: member.id,
    role: member.role,
    name: member.name,
    login: member.login,
    mobile: groupMobile(member.phone),
    email: member.email,
    active: member.status === "active",
    passwordSet: member.passwordSet,
    shareUrl,
    phones: member.phones.map((phone) => phoneRow(t, linemenT, phone, today, locale)),
  };
}
