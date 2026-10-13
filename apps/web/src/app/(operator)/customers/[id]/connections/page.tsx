/**
 * Customer profile, Connections (VC) tab (T-034, PLAN §12.1): every connection with its status,
 * rent and history; Stop / Start again / Remove with the effect in plain words (Owner and Staff,
 * `connections.status.change`); "Add connection" (`?add=1`, `customers.manage`). Another
 * business's customer and made-up ids answer 404.
 */
import { can, connectionFormOptions, listConnections } from "@cb/core";
import { Button } from "@cb/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { roleCan } from "@/components/shell/access";
import { resolveLocale } from "@/i18n/config";
import { getTenantContext } from "@/lib/auth/session";
import { CustomerProfileShell } from "../../_components/profile-shell";
import { callAsUser, loadCustomerProfile } from "../../_components/server";
import { SavedNotice } from "../summary/saved-notice";
import { AddConnectionForm } from "./_parts/add-connection-form";
import { ConnectionsView } from "./_parts/connections-view";
import { addConnectionAction, changeConnectionStatusAction } from "./actions";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const profile = await loadCustomerProfile(id);
  const shell = await getTranslations("shell");
  return { title: profile?.name ?? shell("routes.customer_connections") };
}

export default async function CustomerConnectionsPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const [{ id }, query, ctx] = await Promise.all([params, searchParams, getTenantContext()]);
  if (!UUID.test(id)) notFound();
  const canManage = roleCan(ctx.role)("customers.manage");
  const canChange = can(ctx.role, "connections.status.change");

  const list = await callAsUser(listConnections, { customerId: id }, ctx);
  if (!list.ok) {
    if (list.error.code === "NOT_FOUND" || list.error.code === "VALIDATION") notFound();
    throw new Error(`connections.list failed: ${list.error.code}`);
  }
  const data = list.value;
  const adding = canManage && data.customerActive && query.add === "1";
  const options = adding ? await callAsUser(connectionFormOptions, { customerId: id }, ctx) : null;
  if (options && !options.ok) {
    throw new Error(`connections.form_options failed: ${options.error.code}`);
  }

  const [t, locale] = await Promise.all([getTranslations("connections"), getLocale()]);
  const addButton =
    canManage && data.customerActive && !adding ? (
      <Button asChild size="lg" icon="add">
        <Link href={`/customers/${id}/connections?add=1`} data-action="add-connection">
          {t("tab.add")}
        </Link>
      </Button>
    ) : null;

  return (
    <CustomerProfileShell customerId={id} tab="connections" action={addButton}>
      {(profile) => (
        <>
          {query.saved === "added" ? <SavedNotice message={t("done.added")} /> : null}
          {adding && options?.ok ? (
            <AddConnectionForm
              action={addConnectionAction.bind(null, profile.id)}
              plans={options.value.plans}
              today={options.value.today}
              latestStartDate={options.value.latestStartDate}
              earliestStartDate={options.value.earliestStartDate}
              cancelHref={`/customers/${profile.id}/connections`}
            />
          ) : null}
          <ConnectionsView
            data={data}
            locale={resolveLocale(locale)}
            duePaise={profile.balancePaise}
            statusAction={canChange ? changeConnectionStatusAction.bind(null, profile.id) : null}
          />
        </>
      )}
    </CustomerProfileShell>
  );
}
