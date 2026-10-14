/**
 * "Download this list" on a report page (T-082): a link to `/api/exports/<kind>` with the page's
 * own filters, so the file has every row the page lists (all pages of it). Shown to the Owner only
 * (`exports.csv`); the route refuses everyone else anyway.
 *
 * `DownloadListLink` is the one line a page adds (it checks the role and loads its words);
 * `DownloadListButton` is the plain part, for tests.
 */
import { can, type ExportKind, type TenantRole } from "@cb/core";
import { Button } from "@cb/ui";
import { getTranslations } from "next-intl/server";
import type { Words } from "./columns";
import { exportHref, type Params } from "./params";

export function DownloadListButton({
  kind,
  params,
  t,
}: {
  kind: ExportKind;
  /** The page's search params (paging is dropped). */
  params: Params;
  t: Words;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button asChild variant="secondary" icon="export">
        <a href={exportHref(kind, params)} download data-testid={`download-${kind}`}>
          {t("exports.download_list")}
        </a>
      </Button>
      <span className="text-sm text-text-muted">{t("exports.download_help")}</span>
    </div>
  );
}

export async function DownloadListLink({
  kind,
  params,
  role,
}: {
  kind: ExportKind;
  params: Params;
  role: TenantRole;
}) {
  if (!can(role, "exports.csv")) return null;
  const t = (await getTranslations()) as unknown as Words;
  return <DownloadListButton kind={kind} params={params} t={t} />;
}
