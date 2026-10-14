/**
 * "Share sign-in on WhatsApp" (T-032, PLAN §12.3): a `wa.me` link whose message has the app link
 * and the lineman's user name. **Never the password**: the Owner tells it in person (the message
 * says so). We only open WhatsApp; we never claim it was sent (CLAUDE.md "Honest states").
 * Pure, so it is unit-tested directly.
 */

/**
 * The lineman app on Google Play. The application id is still the placeholder chosen in T-008
 * (`com.cablebilling.lineman`); H-02 decides the final one, change it here then.
 */
export const LINEMAN_APP_URL =
  "https://play.google.com/store/apps/details?id=com.cablebilling.lineman";

/** A translator for the `team` namespace (next-intl's `t`, or a test double). */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

/** The WhatsApp message: business, app link, user name. */
export function shareMessage(
  t: Translate,
  input: { readonly business: string; readonly app: string; readonly login: string },
): string {
  return t("share_message", {
    business: input.business,
    app: input.app,
    app_url: LINEMAN_APP_URL,
    login: input.login,
  });
}

/**
 * `https://wa.me/91<mobile>?text=…` (opens the chat with the lineman), or `https://wa.me/?text=…`
 * (WhatsApp asks whom to send it to) when there is no usable 10-digit Indian mobile number.
 */
export function whatsAppShareUrl(mobile: string | null | undefined, text: string): string {
  const digits = (mobile ?? "").replace(/\D/g, "");
  const local = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
  const to = /^[6-9]\d{9}$/.test(local) ? `91${local}` : "";
  return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
}
