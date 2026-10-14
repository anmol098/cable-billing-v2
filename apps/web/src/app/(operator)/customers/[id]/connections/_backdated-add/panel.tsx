/**
 * The Owner's "Add connection" panel on the Connections tab (`?add=1`, T-045a): binds the Server
 * Actions to the customer and renders ./form.tsx. Staff get T-034's form instead (the page
 * decides by role; the services check it again).
 */
import type { ConnectionPlanOption } from "@cb/core";
import { previewAddAction, saveAddAction } from "./actions";
import { BackDatedAddForm } from "./form";

export function BackDatedAddPanel({
  customerId,
  plans,
  today,
  latestStartDate,
  cancelHref,
}: {
  customerId: string;
  plans: readonly ConnectionPlanOption[];
  today: string;
  latestStartDate: string;
  cancelHref: string;
}) {
  return (
    <BackDatedAddForm
      save={saveAddAction.bind(null, customerId)}
      preview={previewAddAction.bind(null, customerId)}
      plans={plans}
      today={today}
      latestStartDate={latestStartDate}
      cancelHref={cancelHref}
    />
  );
}
