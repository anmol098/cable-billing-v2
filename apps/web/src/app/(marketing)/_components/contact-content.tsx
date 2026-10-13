import { Card, cn, Icon, type IconName } from "@cb/ui";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { RESET_PATH, TEXT_LINK } from "./links";

export type ContactDetails = {
  /** `SUPPORT_EMAIL`, a plain address. */
  email?: string | undefined;
  /** `SUPPORT_PHONE`, `+91` and 10 digits. */
  phone?: string | undefined;
};

/** `+919876543210` → `+91 98765 43210` (how Indian mobiles are read out). */
export function formatIndianMobile(phone: string): string {
  const digits = phone.replace(/^\+91/, "");
  return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
}

/** `+919876543210` → WhatsApp's click-to-chat link (country code + number, digits only). */
export function whatsappLink(phone: string): string {
  return `https://wa.me/${phone.replace(/\D/g, "")}`;
}

function Row({ icon, label, children }: { icon: IconName; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <Icon name={icon} className="mt-3 size-icon shrink-0" />
      <div className="flex min-w-0 flex-col">
        <p className="text-text-muted">{label}</p>
        {children}
      </div>
    </div>
  );
}

/**
 * `/contact`: the support email and phone from the environment (`SUPPORT_EMAIL`,
 * `SUPPORT_PHONE`), each as a link that opens the phone's own app. Says so honestly when they are
 * not configured (local, previews); production requires the email.
 */
export function ContactContent({ email, phone }: ContactDetails) {
  const t = useTranslations("marketing.contact");
  const hasAny = Boolean(email || phone);
  return (
    <div className="flex max-w-180 flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="font-strong text-2xl">{t("title")}</h1>
        <p className="text-lg">{t("lead")}</p>
      </div>

      {hasAny ? (
        <Card className="flex flex-col gap-4 p-6">
          {email ? (
            <Row icon="email" label={t("email")}>
              <a href={`mailto:${email}`} className={cn(TEXT_LINK, "break-all text-lg")}>
                {email}
              </a>
            </Row>
          ) : null}
          {phone ? (
            <Row icon="call" label={t("phone")}>
              <a
                href={`tel:${phone}`}
                aria-label={t("call", { phone: formatIndianMobile(phone) })}
                className={cn(TEXT_LINK, "font-numeric text-lg")}
              >
                {formatIndianMobile(phone)}
              </a>
            </Row>
          ) : null}
          {phone ? (
            <Row icon="whatsapp" label={t("whatsapp_label")}>
              <a href={whatsappLink(phone)} rel="noopener noreferrer" className={TEXT_LINK}>
                {t("whatsapp")}
              </a>
            </Row>
          ) : null}
        </Card>
      ) : (
        <p className="rounded-md border-hairline border-border bg-surface p-4">{t("not_set")}</p>
      )}

      <section aria-labelledby="users-title" className="flex flex-col gap-2">
        <h2 id="users-title" className="font-strong text-xl">
          {t("users.title")}
        </h2>
        <p className="flex flex-wrap items-center gap-x-2">
          <span>{t("users.reset")}</span>
          <a href={RESET_PATH} className={TEXT_LINK}>
            {t("users.reset_link")}
          </a>
        </p>
        <p>{t("users.linemen")}</p>
      </section>
    </div>
  );
}
