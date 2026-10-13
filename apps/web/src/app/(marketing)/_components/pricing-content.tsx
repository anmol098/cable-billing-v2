import { Card, Icon } from "@cb/ui";
import { useTranslations } from "next-intl";
import { marketingFacts } from "../_lib/facts";
import { SignInLine, TrialButton } from "./links";

/** What the one plan includes. */
export const PRICING_INCLUDED = ["unlimited_customers", "apps", "languages", "trial"] as const;

/** Questions, each answered in one or two plain sentences, all visible (no accordion). */
export const PRICING_FAQ = [
  "after_trial",
  "not_paid",
  "data",
  "customers",
  "gst",
  "customer_money",
] as const;

/** `/pricing`: the number first (PLAN §2.2 rule 2), then what it includes, then questions. */
export function PricingContent() {
  const t = useTranslations("marketing.pricing");
  const facts = marketingFacts();
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-2">
        <h1 className="font-strong text-2xl">{t("title")}</h1>
        <p className="text-lg">{t("lead")}</p>
      </div>

      <Card className="flex flex-col gap-6 p-6 sm:max-w-120">
        <div className="flex flex-col gap-1">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-numeric font-strong text-amount" data-testid="price">
              {facts.price}
            </span>
            <span className="text-lg">{t("per_month")}</span>
          </p>
          <p className="text-text-muted">{t("total", facts)}</p>
        </div>
        <div className="flex flex-col gap-3">
          <h2 className="font-strong text-lg">{t("included")}</h2>
          <ul className="flex flex-col gap-2">
            {PRICING_INCLUDED.map((item) => (
              <li key={item} className="flex items-start gap-3">
                <Icon name="success" className="mt-1 shrink-0" />
                <span>{t(item, facts)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-2">
          <TrialButton />
          <p className="text-text-muted">{t("no_card")}</p>
        </div>
      </Card>

      <section aria-labelledby="faq-title" className="flex flex-col gap-6">
        <h2 id="faq-title" className="font-strong text-xl">
          {t("faq.title")}
        </h2>
        {PRICING_FAQ.map((id) => (
          <div key={id} className="flex flex-col gap-1">
            <h3 className="font-strong text-lg">{t(`faq.${id}.q`, facts)}</h3>
            <p>{t(`faq.${id}.a`, facts)}</p>
          </div>
        ))}
      </section>

      <SignInLine />
    </div>
  );
}
