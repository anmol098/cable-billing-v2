import { Card, Icon, type IconName } from "@cb/ui";
import { useTranslations } from "next-intl";
import { marketingFacts } from "../_lib/facts";
import { SignInLine, TrialButton } from "./links";

/** What the app does, one card each: icon + short title + one plain sentence (PLAN §2.2). */
export const HOME_FEATURES = [
  { id: "customers", icon: "customer" },
  { id: "bills", icon: "bill" },
  { id: "lineman_app", icon: "lineman" },
  { id: "receipts", icon: "print" },
  { id: "cash", icon: "handover" },
  { id: "dues", icon: "report" },
  { id: "language", icon: "language" },
] as const satisfies ReadonlyArray<{ id: string; icon: IconName }>;

/** The first steps after sign-up (the same order as T-029's setup checklist). */
export const HOME_STEPS = ["sign_up", "add", "linemen"] as const;

/** `/`: what Cable Billing does, in plain words, and one way to start. */
export function HomeContent() {
  const t = useTranslations("marketing.home");
  const common = useTranslations("common");
  const facts = marketingFacts();
  return (
    <div className="flex flex-col gap-12">
      <section aria-labelledby="hero-title" className="flex flex-col gap-4">
        <h1 id="hero-title" className="font-strong text-2xl">
          {common("app_name")}
        </h1>
        <p className="text-xl">{t("lead")}</p>
        <p className="text-text-muted">{t("languages")}</p>
        <div className="flex flex-col gap-2">
          <p className="font-strong text-lg">{t("trial_line", facts)}</p>
          <p className="text-text-muted">{t("no_card")}</p>
        </div>
        <div>
          <TrialButton />
        </div>
        <SignInLine />
      </section>

      <section aria-labelledby="features-title" className="flex flex-col gap-4">
        <h2 id="features-title" className="font-strong text-xl">
          {t("features.title")}
        </h2>
        <ul className="grid gap-4 sm:grid-cols-2">
          {HOME_FEATURES.map(({ id, icon }) => (
            <li key={id}>
              <Card className="flex h-full gap-4">
                <Icon name={icon} className="size-icon-large shrink-0" />
                <div className="flex flex-col gap-1">
                  <h3 className="font-strong text-lg">{t(`features.${id}.title`)}</h3>
                  <p>{t(`features.${id}.text`)}</p>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="steps-title" className="flex flex-col gap-4">
        <h2 id="steps-title" className="font-strong text-xl">
          {t("steps.title")}
        </h2>
        <ol className="flex flex-col gap-3">
          {HOME_STEPS.map((step, index) => (
            <li key={step} className="flex items-center gap-4">
              <span
                aria-hidden="true"
                className="flex size-touch-min shrink-0 items-center justify-center rounded-full border-strong border-text font-numeric font-strong text-lg"
              >
                {index + 1}
              </span>
              <span className="text-lg">{t(`steps.${step}`)}</span>
            </li>
          ))}
        </ol>
      </section>

      <section
        aria-labelledby="cta-title"
        className="flex flex-col gap-4 rounded-lg border-hairline border-border bg-surface p-6"
      >
        <h2 id="cta-title" className="font-strong text-xl">
          {t("cta.title", facts)}
        </h2>
        <p>{t("trial_line", facts)}</p>
        <div>
          <TrialButton />
        </div>
      </section>
    </div>
  );
}
