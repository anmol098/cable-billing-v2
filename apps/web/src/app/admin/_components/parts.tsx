/** Small building blocks of the admin console (token classes only, words passed in). */
import type { SubscriptionStatus } from "@cb/db";
import { Card, cn, PageHeader, StatusPill, type StatusPillVariant } from "@cb/ui";
import type { ReactNode } from "react";

export function AdminPageHeader({
  title,
  description,
  action,
  back,
}: {
  title: string;
  description?: string;
  action?: React.ReactElement;
  back?: ReactNode;
}) {
  return (
    <PageHeader
      title={title}
      {...(description ? { description } : {})}
      {...(action ? { action, actionPlacement: "inline" as const } : {})}
      {...(back ? { back } : {})}
    />
  );
}

export function Section({
  title,
  children,
  className,
  ...props
}: {
  title: string;
  children: ReactNode;
  className?: string;
} & Record<`data-${string}`, string>) {
  return (
    <Card className={cn("flex flex-col gap-3", className)} {...props}>
      <h2 className="font-strong text-lg">{title}</h2>
      {children}
    </Card>
  );
}

/** A number first, then its words. */
export function Stat({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="flex flex-col">
      <span className="font-numeric font-strong text-xl">{value}</span>
      <span className="text-sm text-text-muted">{label}</span>
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">{children}</div>;
}

export const SUBSCRIPTION_PILL: Record<SubscriptionStatus | "none", StatusPillVariant> = {
  trialing: "pending",
  active: "success",
  grace: "pending",
  read_only: "danger",
  cancelled: "danger",
  none: "danger",
};

export function SubscriptionPill({
  status,
  label,
}: {
  status: SubscriptionStatus | null;
  label: string;
}) {
  return <StatusPill variant={SUBSCRIPTION_PILL[status ?? "none"]} label={label} />;
}

/** The outcome of the last action (from `?done=` / `?error=`), in words. */
export function Outcome({ tone, children }: { tone: "success" | "danger"; children: ReactNode }) {
  return (
    <p
      role={tone === "danger" ? "alert" : "status"}
      data-outcome={tone}
      className={cn(
        "rounded-md border p-3 text-base",
        tone === "danger" ? "border-danger text-danger" : "border-success text-success",
      )}
    >
      {children}
    </p>
  );
}

/** Label + value rows (definition list). */
export function Facts({ rows }: { rows: readonly { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-text-muted">{row.label}</dt>
          <dd className="font-strong">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A label above a form control. */
export function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-strong">
        {label}
      </label>
      {children}
      {hint ? <p className="text-sm text-text-muted">{hint}</p> : null}
    </div>
  );
}
