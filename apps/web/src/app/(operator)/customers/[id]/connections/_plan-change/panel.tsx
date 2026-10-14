/**
 * The Connections tab's "Change plan" (`?change=<assignmentId>`, Owner and Staff) and the Owner's
 * "Change from an earlier day" (`?backdate=<assignmentId>`) panel (T-045). The page renders it
 * above the connection list; the form itself is ./change-form.tsx.
 */
import type { ConnectionDetail, ConnectionPlanOption } from "@cb/core";
import { previewChangeAction, saveChangeAction } from "./actions";
import { ConnectionChangeForm } from "./change-form";
import type { ChangeKind } from "./results";

/** `?change=` / `?backdate=` → which panel, for which connection (null: none). */
export function changeRequestOf(query: Record<string, string | string[] | undefined>): {
  readonly mode: "plan" | "backdate";
  readonly assignmentId: string;
} | null {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const change = first(query.change);
  if (change) return { mode: "plan", assignmentId: change.toLowerCase() };
  const backdate = first(query.backdate);
  if (backdate) return { mode: "backdate", assignmentId: backdate.toLowerCase() };
  return null;
}

/** The changes the Owner can date back for this connection (its allowed actions). */
export function backdateKinds(connection: ConnectionDetail): ChangeKind[] {
  const kinds: ChangeKind[] = [];
  if (connection.actions.includes("change_plan")) kinds.push("plan");
  for (const action of ["suspend", "reactivate", "disconnect"] as const) {
    if (connection.actions.includes(action)) kinds.push(action);
  }
  return kinds;
}

function lastChangeOf(connection: ConnectionDetail): string {
  let latest = connection.startDate;
  for (const event of connection.events) {
    if (event.effectiveDate > latest) latest = event.effectiveDate;
  }
  return latest;
}

export function ConnectionChangePanel({
  customerId,
  connection,
  mode,
  isOwner,
  plans,
  today,
}: {
  customerId: string;
  connection: ConnectionDetail;
  mode: "plan" | "backdate";
  isOwner: boolean;
  plans: readonly ConnectionPlanOption[];
  today: string;
}) {
  const tabHref = `/customers/${customerId}/connections`;
  return (
    <ConnectionChangeForm
      key={`${mode}-${connection.assignmentId}`}
      assignmentId={connection.assignmentId}
      vcNumber={connection.vcNumber}
      mode={mode}
      isOwner={isOwner}
      kinds={mode === "plan" ? ["plan"] : backdateKinds(connection)}
      plans={plans}
      currentPlanId={connection.planId}
      currentRentalPaise={connection.rentalPaise}
      today={today}
      minDate={lastChangeOf(connection)}
      preview={previewChangeAction}
      save={saveChangeAction.bind(null, customerId)}
      doneHref={`${tabHref}?saved=${mode === "plan" ? "plan" : "backdate"}`}
      cancelHref={tabHref}
    />
  );
}
