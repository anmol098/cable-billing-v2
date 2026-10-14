"use client";

/**
 * The file's lines with their status and what to fix (T-084, PLAN §12.2 "preview with errors
 * highlighted per row"): a filter (Problems / Ready or Added / Already in the app / All), a
 * DataTable of 5 columns (cards on phones), 50 lines at a time with "Show more".
 */
import type { ImportLine, ImportLineResult, ImportLineStatus } from "@cb/core";
import { formatINR, parseRupeesInput } from "@cb/domain";
import { Button, cn, DataTable, type DataTableColumn, StatusPill } from "@cb/ui";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { MutedPill } from "../../_components/status-pills";
import { type ImportWords, problemsText } from "../_lib/words";

export interface LineRow {
  readonly line: ImportLine;
  readonly result: ImportLineResult;
}

export type LineFilter = "problem" | "ready" | "exists" | "all";

const PAGE = 50;

export function StatusWord({ status }: { status: ImportLineStatus }) {
  const t = useTranslations("import");
  switch (status) {
    case "ready":
      return <StatusPill variant="pending" icon="add" label={t("status.ready")} />;
    case "created":
      return <StatusPill variant="success" label={t("status.created")} />;
    case "exists":
      return <MutedPill label={t("status.exists")} />;
    default:
      return <StatusPill variant="danger" label={t("status.problem")} />;
  }
}

function matches(filter: LineFilter, status: ImportLineStatus): boolean {
  if (filter === "all") return true;
  if (filter === "ready") return status === "ready" || status === "created";
  return status === filter;
}

export function LinesTable({
  rows,
  initialFilter,
  done,
}: {
  rows: readonly LineRow[];
  initialFilter: LineFilter;
  /** After the import: "Ready" reads "Added". */
  done: boolean;
}) {
  const raw = useTranslations("import");
  const t = raw as unknown as ImportWords;
  const locale = useLocale();
  const [filter, setFilter] = useState<LineFilter>(initialFilter);
  const [shown, setShown] = useState(PAGE);

  const counts = useMemo(() => {
    const result: Record<LineFilter, number> = {
      problem: 0,
      ready: 0,
      exists: 0,
      all: rows.length,
    };
    for (const row of rows) {
      for (const key of ["problem", "ready", "exists"] as const) {
        if (matches(key, row.result.status)) result[key] += 1;
      }
    }
    return result;
  }, [rows]);
  const visible = useMemo(
    () => rows.filter((row) => matches(filter, row.result.status)),
    [rows, filter],
  );

  const filters: { id: LineFilter; label: string }[] = [
    { id: "problem", label: t("table.filter_problem") },
    { id: "ready", label: done ? t("status.created") : t("table.filter_ready") },
    { id: "exists", label: t("table.filter_exists") },
    { id: "all", label: t("table.filter_all") },
  ];

  const box = ({ line }: LineRow) => {
    const v = line.values;
    if (v.vcNumber === "") return <span className="text-text-muted">{t("table.no_box")}</span>;
    if (v.plan !== "") return t("table.box_plan", { vc: v.vcNumber, plan: v.plan });
    const rent = parseRupeesInput(v.rent.replace(/^(?:rs\.?|inr)\s*/i, "").replace(/\.0+$/, ""));
    if (rent.ok && rent.value.paise !== null) {
      return t("table.box_rent", {
        vc: v.vcNumber,
        amount: formatINR(rent.value.paise).replace(/^₹/, ""),
      });
    }
    return t("table.box_vc", { vc: v.vcNumber });
  };

  const columns: DataTableColumn<LineRow>[] = [
    {
      id: "line",
      header: t("table.col_line"),
      cell: ({ line }) => <span className="font-numeric">{line.line}</span>,
    },
    {
      id: "customer",
      header: t("table.col_customer"),
      primary: true,
      cell: ({ line, result }) => {
        const label = [line.values.code, line.values.name].filter(Boolean).join(" · ");
        return result.customer ? (
          <Link
            prefetch={false}
            href={`/customers/${result.customer.id}`}
            className="relative z-10 underline-offset-4 hover:underline"
          >
            {label || result.customer.code}
          </Link>
        ) : (
          label
        );
      },
    },
    { id: "box", header: t("table.col_box"), cell: box },
    {
      id: "status",
      header: t("table.col_status"),
      cell: ({ result }) => <StatusWord status={result.status} />,
    },
    {
      id: "fix",
      header: t("table.col_fix"),
      cell: ({ result }) =>
        result.problems.length > 0 ? (
          <span className="text-danger">
            {problemsText(t, result.problems, locale === "hi" ? "hi" : "en")}
          </span>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-wrap items-center gap-2">
        <legend className="sr-only">{t("table.show")}</legend>
        {filters.map((item) => (
          <Button
            key={item.id}
            type="button"
            variant={filter === item.id ? "primary" : "secondary"}
            aria-pressed={filter === item.id}
            onClick={() => {
              setFilter(item.id);
              setShown(PAGE);
            }}
          >
            {item.label}
            <span className="font-numeric">({counts[item.id]})</span>
          </Button>
        ))}
      </fieldset>
      <DataTable
        caption={t("table.caption")}
        columns={columns}
        rows={visible.slice(0, shown)}
        rowKey={(row) => String(row.line.line)}
        empty={<p className="py-4 text-text-muted">{t("table.nothing")}</p>}
      />
      {visible.length > shown ? (
        <div className={cn("flex flex-wrap items-center gap-3")}>
          <p className="text-sm text-text-muted">
            {t("table.showing", { shown, total: visible.length })}
          </p>
          <Button type="button" variant="secondary" onClick={() => setShown((n) => n + PAGE * 4)}>
            {t("table.show_more")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
