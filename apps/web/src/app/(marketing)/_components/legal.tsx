import { formatBusinessDate } from "@cb/domain";
import type { Locale } from "@cb/i18n";
import { Icon } from "@cb/ui";
import { useLocale, useTranslations } from "next-intl";
import { LEGAL_DRAFT_DATE, marketingFacts, RECEIPT_LINK_DAYS } from "../_lib/facts";
import { MARKETING_PATHS, TEXT_LINK } from "./links";

/**
 * A section of a legal page: a heading plus either paragraphs or a bulleted list. `contact` adds a
 * "Contact us" link after it. Keys are `marketing.<doc>.<id>.title` and `.<id>.<part>`.
 */
type LegalSection = {
  readonly id: string;
  readonly paragraphs?: readonly string[];
  readonly list?: readonly string[];
  readonly contact?: boolean;
};

export const PRIVACY_SECTIONS = [
  { id: "who", paragraphs: ["text"] },
  { id: "collect", list: ["owner", "customers", "team", "phone_app", "activity", "fee"] },
  { id: "use", list: ["run", "safety", "email", "fee", "fix"] },
  { id: "operator_data", paragraphs: ["text"] },
  { id: "receipts", paragraphs: ["text"] },
  { id: "others", paragraphs: ["text", "location"] },
  { id: "cookies", paragraphs: ["text"] },
  { id: "keep", paragraphs: ["text"] },
  { id: "safety", paragraphs: ["text"] },
  { id: "requests", paragraphs: ["text"], contact: true },
  { id: "changes", paragraphs: ["text"] },
] as const satisfies readonly LegalSection[];

export const TERMS_SECTIONS = [
  { id: "service", paragraphs: ["text"] },
  { id: "account", paragraphs: ["text"] },
  { id: "price", paragraphs: ["text"] },
  { id: "not_paid", paragraphs: ["text"] },
  { id: "cancel", paragraphs: ["text"] },
  { id: "data", paragraphs: ["text"] },
  { id: "receipts", paragraphs: ["text"] },
  { id: "messages", paragraphs: ["text"] },
  { id: "money", paragraphs: ["text"] },
  { id: "records", paragraphs: ["text"] },
  { id: "changes", paragraphs: ["text"], contact: true },
] as const satisfies readonly LegalSection[];

export type LegalDocument = "privacy" | "terms";

const SECTIONS: Record<LegalDocument, readonly LegalSection[]> = {
  privacy: PRIVACY_SECTIONS,
  terms: TERMS_SECTIONS,
};

/**
 * "Draft: for legal review" — shown at the top of both legal pages until a lawyer has approved
 * the text (T-087 notes). Amber + clock: not final yet, waiting for someone (PLAN §2.2 colours).
 */
function DraftNotice() {
  const t = useTranslations("marketing.legal");
  const locale = useLocale() as Locale;
  return (
    <div
      role="note"
      className="flex gap-3 rounded-md border-strong border-pending bg-bg p-4"
      data-testid="draft-notice"
    >
      <Icon name="pending" className="mt-1 size-icon shrink-0 text-pending" />
      <div className="flex flex-col gap-1">
        <p className="font-strong text-lg text-pending">{t("draft_title")}</p>
        <p>{t("draft_body")}</p>
        <p className="text-text-muted">
          {t("draft_date", { date: formatBusinessDate(LEGAL_DRAFT_DATE, locale) })}
        </p>
      </div>
    </div>
  );
}

/** `/privacy` and `/terms`: the draft notice, an intro and short numbered sections. */
export function LegalContent({ doc }: { doc: LegalDocument }) {
  // One translator for both documents; the keys below are built from the typed section lists.
  const t = useTranslations("marketing") as unknown as (
    key: string,
    values?: Record<string, string | number>,
  ) => string;
  const values = marketingFacts();
  // The receipt-link sentence counts the link's days, not the trial's.
  const valuesFor = (id: string) =>
    doc === "privacy" && id === "receipts" ? { ...values, days: RECEIPT_LINK_DAYS } : values;
  return (
    <article className="flex max-w-180 flex-col gap-8">
      <div className="flex flex-col gap-4">
        <h1 className="font-strong text-2xl">{t(`${doc}.title`)}</h1>
        <DraftNotice />
        <p className="text-lg">{t(`${doc}.intro`)}</p>
      </div>
      <ol className="flex flex-col gap-6">
        {SECTIONS[doc].map((section, index) => (
          <li key={section.id} className="flex flex-col gap-2">
            <h2 className="flex gap-2 font-strong text-xl">
              <span className="font-numeric">{index + 1}.</span>
              <span>{t(`${doc}.${section.id}.title`)}</span>
            </h2>
            {section.paragraphs?.map((part) => (
              <p key={part}>{t(`${doc}.${section.id}.${part}`, valuesFor(section.id))}</p>
            ))}
            {section.list ? (
              <ul className="flex list-disc flex-col gap-2 pl-6">
                {section.list.map((part) => (
                  <li key={part}>{t(`${doc}.${section.id}.${part}`, valuesFor(section.id))}</li>
                ))}
              </ul>
            ) : null}
            {section.contact ? (
              <p>
                <a href={MARKETING_PATHS.contact} className={TEXT_LINK}>
                  {t("legal.contact_link")}
                </a>
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </article>
  );
}
