/**
 * The business profile, read-only (T-030): what Staff see, and what the Owner sees while the
 * tenant is read-only (D-13). Same groups and words as the form, values as text, no buttons.
 */
import type { BusinessProfile, SettingsReadOnlyReason } from "@cb/core";
import { Card } from "@cb/ui";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { Notice } from "./field";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd className="whitespace-pre-line text-base text-text">{children}</dd>
    </div>
  );
}

export function ProfileView({
  title,
  profile,
  reason,
}: {
  title: string;
  profile: BusinessProfile;
  reason: SettingsReadOnlyReason;
}) {
  const t = useTranslations("settings");
  const empty = t("profile.empty_value");
  const policy =
    profile.midMonthStartPolicy === "charge_full_month"
      ? { label: t("profile.mid_month_charge"), explain: t("profile.mid_month_charge_explain") }
      : { label: t("profile.mid_month_next"), explain: t("profile.mid_month_next_explain") };
  return (
    <div className="flex flex-col gap-6" data-read-only={reason}>
      <ShellPageHeader title={title} description={t("profile.description")} />
      <Notice tone="pending">{t(`read_only.${reason}`)}</Notice>
      <Card className="flex flex-col gap-4">
        <h2 className="font-strong text-xl">{t("profile.section_business")}</h2>
        <dl className="flex flex-col gap-4">
          <Row label={t("profile.name_label")}>{profile.name}</Row>
          <Row label={t("profile.phone_label")}>
            {profile.phone ? <span className="font-numeric">{profile.phone}</span> : empty}
          </Row>
          <Row label={t("profile.address_label")}>{profile.address ?? empty}</Row>
        </dl>
      </Card>
      <Card className="flex flex-col gap-4">
        <h2 className="font-strong text-xl">{t("profile.section_receipts")}</h2>
        <dl className="flex flex-col gap-4">
          <Row label={t("profile.footer_label")}>{profile.receiptFooter ?? empty}</Row>
          <Row label={t("profile.prefix_label")}>
            <span className="font-numeric">{profile.invoicePrefix}</span>
          </Row>
          <Row label={t("profile.language_label")}>
            {profile.defaultLanguage === "hi" ? "हिंदी" : "English"}
          </Row>
        </dl>
      </Card>
      <Card className="flex flex-col gap-4">
        <h2 className="font-strong text-xl">{t("profile.section_mid_month")}</h2>
        <p className="text-base">{t("profile.mid_month_question")}</p>
        <dl>
          <Row label={policy.label}>{policy.explain}</Row>
        </dl>
        <p className="text-sm text-text-muted">{t("profile.mid_month_note")}</p>
      </Card>
    </div>
  );
}
