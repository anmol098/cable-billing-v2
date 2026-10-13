// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { Amount } from "../primitives/Amount";
import { StatusPill } from "../primitives/StatusPill";
import { axeViolations } from "../primitives/test-helpers";
import { DATA_TABLE_MAX_COLUMNS, DataTable, type DataTableColumn } from "./DataTable";
import { EmptyState } from "./EmptyState";

type Customer = { id: string; name: string; area: string; duePaise: number; active: boolean };

const ROWS: Customer[] = [
  { id: "c1", name: "Ramesh Kumar", area: "Ward 4", duePaise: 45_000, active: true },
  { id: "c2", name: "Sita Devi", area: "Ward 7", duePaise: 0, active: false },
];

const COLUMNS: DataTableColumn<Customer>[] = [
  { id: "area", header: "Area", cell: (row) => row.area },
  { id: "name", header: "Customer", cell: (row) => row.name, primary: true },
  {
    id: "status",
    header: "Status",
    cell: (row) =>
      row.active ? (
        <StatusPill variant="success" label="Active" />
      ) : (
        <StatusPill variant="danger" label="Stopped" />
      ),
  },
  {
    id: "due",
    header: "Due",
    align: "end",
    cell: (row) => <Amount paise={row.duePaise} tone="balance" />,
  },
];

function views() {
  const table = screen.getByRole("table", { name: "Customers" });
  const cards = screen.getByRole("list", { name: "Customers" });
  return { table, cards };
}

describe("DataTable", () => {
  it("renders a table from sm up and a card list under sm (CSS switch, no JS)", () => {
    render(<DataTable caption="Customers" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    const { table, cards } = views();

    // The breakpoint switch: the table is hidden below `sm`, the cards from `sm` up.
    expect(table).toHaveClass("hidden", "sm:table");
    expect(table).toHaveAttribute("data-view", "table");
    expect(cards).toHaveClass("sm:hidden");
    expect(cards).not.toHaveClass("hidden");
    expect(cards).toHaveAttribute("data-view", "cards");

    // Table: header row + one row per record, columns in the given order.
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((th) => th.textContent);
    expect(headers).toEqual(["Area", "Customer", "Status", "Due"]);
    expect(within(table).getAllByRole("row")).toHaveLength(ROWS.length + 1);
  });

  it("card fallback: one card per row, the primary column as title, the others as label + value", () => {
    render(<DataTable caption="Customers" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    const items = within(views().cards).getAllByRole("listitem");
    expect(items).toHaveLength(2);

    const [first, second] = items as [HTMLElement, HTMLElement];
    // The title is the primary column (not the first column).
    expect(first.firstElementChild).toHaveTextContent("Ramesh Kumar");
    // The other columns become label/value pairs, in column order, without the primary one.
    const terms = within(first)
      .getAllByRole("term")
      .map((dt) => dt.textContent);
    expect(terms).toEqual(["Area", "Status", "Due"]);
    const definitions = within(first).getAllByRole("definition");
    expect(definitions[0]).toHaveTextContent("Ward 4");
    expect(definitions[1]).toHaveTextContent("Active");
    expect(definitions[2]).toHaveTextContent("₹450");
    expect(second).toHaveTextContent("Stopped");
    // Numbers are end-aligned in the table too.
    const dueCell = views().table.querySelector('td[data-column="due"]');
    expect(dueCell).toHaveClass("text-end");
  });

  it("row click: the whole card/row is one button (stretched), keyboard operable", async () => {
    const onRowClick = vi.fn();
    render(
      <DataTable
        caption="Customers"
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        onRowClick={onRowClick}
      />,
    );
    const user = userEvent.setup();

    const cardButton = within(views().cards).getByRole("button", { name: "Sita Devi" });
    expect(cardButton).toHaveClass("after:absolute", "after:inset-0");
    expect(cardButton.closest("li")).toHaveClass("relative");
    await user.click(cardButton);
    expect(onRowClick).toHaveBeenLastCalledWith(ROWS[1]);

    const rowButton = within(views().table).getByRole("button", { name: "Ramesh Kumar" });
    expect(rowButton.closest("tr")).toHaveClass("relative", "cursor-pointer");
    rowButton.focus();
    await user.keyboard("{Enter}");
    expect(onRowClick).toHaveBeenLastCalledWith(ROWS[0]);
    expect(onRowClick).toHaveBeenCalledTimes(2);
    expect(await axeViolations()).toEqual([]);
  });

  it("rowHref renders links (any link component) in both views", async () => {
    function FakeLink(props: { href: string; className?: string; children?: ReactNode }) {
      return <a data-fake-link="" {...props} />;
    }
    render(
      <DataTable
        caption="Customers"
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        rowHref={(row) => `/customers/${row.id}`}
        linkAs={FakeLink}
      />,
    );
    const links = screen.getAllByRole("link", { name: "Ramesh Kumar" });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toHaveAttribute("href", "/customers/c1");
      expect(link).toHaveAttribute("data-fake-link");
    }
    expect(screen.queryByRole("button")).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  it("without a click handler the primary cell is plain text", () => {
    render(<DataTable caption="Customers" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows the empty state instead of an empty table", () => {
    render(
      <DataTable
        caption="Customers"
        columns={COLUMNS}
        rows={[]}
        rowKey={(r) => r.id}
        empty={<EmptyState icon="customer" message="No customers yet." />}
      />,
    );
    expect(screen.getByText("No customers yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it(`refuses more than ${DATA_TABLE_MAX_COLUMNS} columns (PLAN §12.2)`, () => {
    const six = Array.from({ length: 6 }, (_, index) => ({
      id: `c${index}`,
      header: `C${index}`,
      cell: () => index,
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(<DataTable caption="Too wide" columns={six} rows={[]} rowKey={() => "x"} />),
    ).toThrow(/6 columns; the limit is 5/);
    vi.restoreAllMocks();
  });
});
