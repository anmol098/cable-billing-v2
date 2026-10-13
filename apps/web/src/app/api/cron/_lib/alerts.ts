/**
 * The words of the job-failure emails (T-043), from the `job_alerts` i18n namespace, in the
 * recipient's language. The platform admin gets the technical details; the tenant owner a short,
 * plain message (no error text: it means nothing to them and could be alarming).
 */
import type { RenderJobAlert } from "@cb/core";
import type { Locale } from "@cb/i18n";
import { createTranslator } from "next-intl";
import { TIME_ZONE } from "@/i18n/config";
import en from "../../../../../messages/en.json";
import hi from "../../../../../messages/hi.json";

const MESSAGES = { en, hi } as const;

/** Dates are formatted in code (packages/i18n README), in IST. */
export function formatAlertTime(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", {
    timeZone: TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export const renderJobAlert: RenderJobAlert = ({ audience, language, failure }) => {
  const t = createTranslator({
    locale: language,
    messages: MESSAGES[language],
    namespace: "job_alerts",
  });
  const failedAt = formatAlertTime(failure.failedAt, language);
  if (audience === "owner") {
    return {
      subject: t("owner.subject"),
      text: [
        t("owner.intro", { failedAt }),
        "",
        t("owner.next_step"),
        "",
        t("owner.ref", { jobId: failure.jobId }),
      ].join("\n"),
    };
  }
  return {
    subject: t("admin.subject", { jobType: failure.type }),
    text: [
      t("admin.intro"),
      "",
      t("admin.job_type", { jobType: failure.type }),
      t("admin.job_id", { jobId: failure.jobId }),
      failure.operatorId === null
        ? t("admin.platform")
        : t("admin.operator", { operatorId: failure.operatorId }),
      t("admin.attempts", { attempts: failure.attempts, maxAttempts: failure.maxAttempts }),
      t("admin.reason", { reason: t(`reason.${failure.reason}`) }),
      t("admin.error", { error: failure.lastError }),
      t("admin.time", { failedAt }),
      "",
      t("admin.next_step"),
    ].join("\n"),
  };
};
