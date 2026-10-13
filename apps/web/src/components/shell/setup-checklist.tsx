/**
 * The Home page's setup checklist for new businesses (PLAN §12.3 step 3): ① plans → ② customers
 * → ③ linemen → ④ the app on linemen's phones. Props-driven: T-083 passes `done` from real data
 * (and the Play Store link / QR for the last step); until then every step shows as not done.
 */
import { Button, Card, cn, Icon, StatusPill } from "@cb/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type CanFn, findRoute, type NavCapability, type NavRouteId } from "@/lib/nav";

export const SETUP_STEP_IDS = ["plans", "customers", "linemen", "app"] as const;
export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

/** Who can do each step, and where its button goes (`null`: no page yet; T-083 adds the link). */
const STEP_SPEC: Record<SetupStepId, { capability: NavCapability; route: NavRouteId | null }> = {
  plans: { capability: "plans.manage", route: "settings_plans" },
  customers: { capability: "customers.manage", route: "customers_new" },
  linemen: { capability: "team.manage", route: "settings_team" },
  app: { capability: "team.manage", route: null },
};

export type SetupStep = {
  id: SetupStepId;
  done: boolean;
  /** The step's button target; `undefined` shows no button. */
  href?: string;
};

/**
 * The steps this role can act on, in order, with their default links. `done` maps step → done
 * (missing = not done). Staff only see "Add customers"; the Owner sees all four.
 */
export function setupStepsFor(
  can: CanFn,
  done: Partial<Record<SetupStepId, boolean>> = {},
): SetupStep[] {
  return SETUP_STEP_IDS.filter((id) => can(STEP_SPEC[id].capability)).map((id) => {
    const route = STEP_SPEC[id].route;
    return {
      id,
      done: done[id] ?? false,
      href: route ? findRoute(route)?.path : undefined,
    };
  });
}

/** The checklist card; renders nothing when there are no steps or every step is done. */
export function SetupChecklist({ steps }: { steps: readonly SetupStep[] }) {
  const t = useTranslations("shell.checklist");
  const doneCount = steps.filter((step) => step.done).length;
  if (steps.length === 0 || doneCount === steps.length) return null;
  return (
    <Card asChild>
      <section aria-labelledby="setup-checklist-title" data-shell="setup-checklist">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="setup-checklist-title" className="font-strong text-xl">
            {t("title")}
          </h2>
          <p className="font-numeric text-base text-text-muted">
            {t("progress", { done: doneCount, total: steps.length })}
          </p>
        </div>
        <ol className="mt-4 flex flex-col gap-3">
          {steps.map((step, index) => (
            <li
              key={step.id}
              data-step={step.id}
              data-done={step.done || undefined}
              className="flex flex-wrap items-center gap-3 border-t-hairline border-border pt-3"
            >
              <span
                aria-hidden
                className={cn(
                  "inline-flex size-touch-min shrink-0 items-center justify-center rounded-full border-hairline font-numeric font-strong text-lg",
                  step.done ? "border-success text-success" : "border-border text-text",
                )}
              >
                {step.done ? <Icon name="success" className="size-6" /> : index + 1}
              </span>
              <p className="min-w-0 flex-1 text-base">{t(step.id)}</p>
              {step.done ? (
                <StatusPill variant="success" label={t("done")} />
              ) : step.href ? (
                // Phones: the button takes its own full-width line under the words.
                <div className="flex w-full *:w-full sm:w-auto sm:*:w-auto">
                  <Button asChild variant="secondary" icon={step.id === "app" ? "lineman" : "add"}>
                    <Link href={step.href}>{t(`${step.id}_action`)}</Link>
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    </Card>
  );
}
