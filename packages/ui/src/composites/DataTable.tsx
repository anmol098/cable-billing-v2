import type { ElementType, ReactNode } from "react";
import { cn } from "../lib/cn";
import { focusRing } from "../lib/styles";

/** PLAN §12.2: tables have at most 5 columns. */
export const DATA_TABLE_MAX_COLUMNS = 5;

export type DataTableColumn<Row> = {
  /** Stable id (React key, `data-column`). */
  id: string;
  /** Column heading, also the label in the phone card (an i18n string). */
  header: ReactNode;
  /** The cell content for a row (text, `Amount`, `StatusPill`, …). */
  cell: (row: Row) => ReactNode;
  /** `end` for amounts and other numbers. Default `start`. */
  align?: "start" | "end";
  /**
   * The row's name (customer name, bill number). It becomes the row's link or button and the
   * card's title on phones. Default: the first column.
   */
  primary?: boolean;
};

export type DataTableProps<Row> = {
  /** At most `DATA_TABLE_MAX_COLUMNS` (5); more throws, so the rule can't be broken by accident. */
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** What the table lists (an i18n string). The accessible name; visually hidden. */
  caption: string;
  /** Row click (and Enter/Space on the row's button) opens details. */
  onRowClick?: (row: Row) => void;
  /** Or: each row links here. Takes precedence over `onRowClick`. */
  rowHref?: (row: Row) => string;
  /** The link component for `rowHref`, e.g. Next.js `Link`. Default `<a>`. */
  linkAs?: ElementType;
  /** Shown instead of the table when `rows` is empty, usually an `EmptyState`. */
  empty?: ReactNode;
  className?: string;
};

const ALIGN = { start: "text-start", end: "text-end" } as const;

/**
 * A list of records: a table from `sm` up, a stack of cards on phones (no sideways scrolling).
 * The whole row/card is the click target: the primary cell's button or link is stretched over
 * it, so it works with the keyboard and without JavaScript for links. Put any other control in a
 * cell inside an element with `relative z-10` so it sits above the stretched target.
 *
 * Not a client component: server components can render it with `rowHref`.
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  onRowClick,
  rowHref,
  linkAs,
  empty,
  className,
}: DataTableProps<Row>) {
  if (columns.length > DATA_TABLE_MAX_COLUMNS) {
    throw new Error(
      `DataTable "${caption}" has ${columns.length} columns; the limit is ${DATA_TABLE_MAX_COLUMNS} (PLAN §12.2).`,
    );
  }
  if (rows.length === 0 && empty) return <>{empty}</>;

  const primary = columns.find((column) => column.primary) ?? columns[0];
  const others = columns.filter((column) => column !== primary);
  const interactive = Boolean(rowHref || onRowClick);
  const Link = linkAs ?? "a";

  /** The primary cell: a stretched link/button when rows are interactive, else plain text. */
  const rowTarget = (row: Row) => {
    const content = primary ? primary.cell(row) : null;
    const target = cn(
      "rounded-sm text-start font-strong text-text underline-offset-4 hover:underline",
      "after:absolute after:inset-0",
      focusRing,
    );
    if (rowHref) {
      return (
        <Link href={rowHref(row)} className={target}>
          {content}
        </Link>
      );
    }
    if (onRowClick) {
      return (
        <button
          type="button"
          className={cn(target, "cursor-pointer")}
          onClick={() => onRowClick(row)}
        >
          {content}
        </button>
      );
    }
    return <span className="font-strong text-text">{content}</span>;
  };

  return (
    <div className={className} data-slot="data-table">
      <table className="hidden w-full border-collapse sm:table" data-view="table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b-hairline border-border">
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                className={cn(
                  "px-3 py-2 font-strong text-sm text-text-muted",
                  ALIGN[column.align ?? "start"],
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={cn(
                "relative border-b-hairline border-border",
                interactive && "cursor-pointer hover:bg-surface",
              )}
            >
              {columns.map((column) => (
                <td
                  key={column.id}
                  data-column={column.id}
                  className={cn(
                    "min-h-touch-min px-3 py-3 align-middle",
                    ALIGN[column.align ?? "start"],
                  )}
                >
                  {column === primary ? rowTarget(row) : column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <ul aria-label={caption} className="flex flex-col gap-3 sm:hidden" data-view="cards">
        {rows.map((row) => (
          <li
            key={rowKey(row)}
            className={cn(
              "relative flex flex-col gap-3 rounded-lg border-hairline border-border bg-bg p-4",
              interactive && "cursor-pointer hover:bg-surface",
            )}
          >
            <div className="text-lg">{rowTarget(row)}</div>
            {others.length > 0 ? (
              <dl className="flex flex-col gap-2">
                {others.map((column) => (
                  <div
                    key={column.id}
                    data-column={column.id}
                    className="flex items-center justify-between gap-4"
                  >
                    <dt className="text-sm text-text-muted">{column.header}</dt>
                    <dd className="text-end">{column.cell(row)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
