// @vitest-environment jsdom
import { join } from "node:path";
import { __unstable__loadDesignSystem } from "@tailwindcss/node";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import {
  Combobox,
  ConfirmSheet,
  DataTable,
  type DataTableColumn,
  Dialog,
  EmptyState,
  HelpTip,
  LanguageSwitch,
  PAGE_ACTION_CLEARANCE,
  PageHeader,
  Stepper,
  ToastProvider,
  useToast,
} from "../composites";
import { dialogOverlayClasses, dialogPanelClasses } from "../composites/Dialog";
import { fieldBase, focusRing, focusWithinRing } from "../lib/styles";
import {
  Amount,
  AmountInput,
  type AmountSize,
  Button,
  Card,
  Checkbox,
  Divider,
  IconButton,
  Input,
  RadioCards,
  Select,
  Spinner,
  StatusPill,
  type StatusPillVariant,
  Textarea,
  VisuallyHidden,
} from "./index";

/*
 * Every class the primitives put in the DOM must be a real utility of the token theme. A typo or a
 * stock-Tailwind name that the theme removed (`bg-white`, `text-xs`, `shadow-md`) would otherwise
 * render as nothing, silently. This renders every variant, collects the classes and asks Tailwind
 * (compiling the committed theme.css) for the CSS of each one.
 */

type DesignSystem = Awaited<ReturnType<typeof __unstable__loadDesignSystem>>;
let theme: DesignSystem;
let stock: DesignSystem;

beforeAll(async () => {
  const base = join(import.meta.dirname, "..");
  theme = await __unstable__loadDesignSystem('@import "./theme.css";', { base });
  stock = await __unstable__loadDesignSystem('@import "tailwindcss";', { base });
});

const AMOUNT_SIZES: AmountSize[] = ["sm", "base", "lg", "xl", "2xl", "amount"];
const PILLS: StatusPillVariant[] = ["cash", "upi", "pending", "success", "danger"];

function Gallery() {
  return (
    <div>
      {(["primary", "secondary", "quiet", "danger"] as const).map((variant) =>
        (["md", "lg"] as const).map((size) => (
          <div key={`${variant}-${size}`}>
            <Button variant={variant} size={size} icon="cash">
              Go
            </Button>
            <Button variant={variant} size={size} loading loadingLabel="Wait">
              Go
            </Button>
            <Button variant={variant} size={size} disabled>
              Go
            </Button>
            <IconButton
              variant={variant}
              size={size}
              icon="print"
              label={`Print ${variant} ${size}`}
            />
            <IconButton variant={variant} size={size} icon="print" label="Print" showLabel />
          </div>
        )),
      )}
      <Button asChild icon="add">
        <a href="/customers/new">Add customer</a>
      </Button>
      <Input aria-label="i" invalid />
      <Textarea aria-label="t" invalid />
      <Select aria-label="s" placeholder="p" invalid defaultValue="">
        <option value="a">a</option>
      </Select>
      <Checkbox label="c" />
      <Checkbox label="c" description="d" disabled />
      <RadioCards
        aria-label="r"
        defaultValue="a"
        options={[
          { value: "a", label: "A", icon: "cash", iconClassName: "text-cash", description: "x" },
          { value: "b", label: "B", disabled: true },
        ]}
      />
      <AmountInput aria-label="a" invalid disabled />
      {AMOUNT_SIZES.map((size) => (
        <Amount key={size} paise={-100} size={size} creditLabel="Credit" />
      ))}
      <Amount paise={100} tone="balance" dueLabel="Due" weight="regular" />
      <Amount paise={0} tone="balance" />
      {PILLS.map((variant) => (
        <StatusPill key={variant} variant={variant} label={variant} />
      ))}
      <Spinner size="sm" label="l" />
      <Spinner size="md" />
      <Spinner size="lg" />
      <Card>c</Card>
      <Divider />
      <Divider orientation="vertical" />
      <VisuallyHidden>v</VisuallyHidden>
      <CompositeGallery />
    </div>
  );
}

type SampleRow = { id: string; name: string; due: number };
const SAMPLE_ROWS: SampleRow[] = [
  { id: "1", name: "Ramesh", due: 45000 },
  { id: "2", name: "Sita", due: 0 },
];
const SAMPLE_COLUMNS: DataTableColumn<SampleRow>[] = [
  { id: "name", header: "Name", cell: (row) => row.name },
  {
    id: "due",
    header: "Due",
    align: "end",
    cell: (row) => <Amount paise={row.due} tone="balance" />,
  },
];
const STEPS = ["a", "b", "c"].map((id) => ({
  id,
  title: id,
  content: <Input aria-label={id} />,
}));

function ToastButtons() {
  const { toast } = useToast();
  return (
    <Button
      onClick={() => {
        toast({ variant: "success", title: "Saved", description: "d" });
        toast({ variant: "pending", title: "Saved on phone" });
        toast({ variant: "danger", title: "Problem" });
      }}
    >
      Show toasts
    </Button>
  );
}

/** T-007 composites, in every variant; the overlays open from buttons (see renderedClasses). */
function CompositeGallery() {
  const [overlays, setOverlays] = useState(false);
  return (
    <ToastProvider closeLabel="Close" label="Notifications">
      <div className={PAGE_ACTION_CLEARANCE}>
        <PageHeader
          title="Customers"
          description="d"
          back={<span>b</span>}
          action={<Button size="lg">Add</Button>}
        />
        <PageHeader
          title="Inline"
          headingLevel={2}
          actionPlacement="inline"
          action={<Button>Add</Button>}
        />
        <EmptyState icon="customer" message="No customers yet." action={<Button>Add</Button>} />
        <DataTable
          caption="Clickable"
          columns={SAMPLE_COLUMNS}
          rows={SAMPLE_ROWS}
          rowKey={(row) => row.id}
          onRowClick={() => {}}
        />
        <DataTable
          caption="Links"
          columns={SAMPLE_COLUMNS}
          rows={SAMPLE_ROWS}
          rowKey={(row) => row.id}
          rowHref={(row) => `/c/${row.id}`}
        />
        <DataTable
          caption="Plain"
          columns={SAMPLE_COLUMNS}
          rows={SAMPLE_ROWS}
          rowKey={(row) => row.id}
        />
        <Stepper
          steps={STEPS}
          defaultStep={1}
          backLabel="Back"
          nextLabel="Next"
          finishLabel="Save"
          progressLabel={(current, total) => `${current}/${total}`}
        />
        <Stepper
          steps={STEPS}
          defaultStep={2}
          backLabel="Back"
          nextLabel="Next"
          finishLabel="Save"
          finishing
          finishingLabel="Saving"
          progressLabel={(current, total) => `${current}/${total}`}
        />
        <Combobox
          label="Find customer"
          loadOptions={async () => [
            { value: "1", label: "Ramesh", description: "C-1" },
            { value: "2", label: "Sita" },
          ]}
          onSelect={() => {}}
          debounceMs={0}
          loadingLabel="Searching"
          emptyLabel="None"
          errorLabel="Error"
        />
        <Combobox
          label="Hidden label"
          hideLabel
          loadOptions={async () => []}
          onSelect={() => {}}
          loadingLabel="Searching"
          emptyLabel="None"
          errorLabel="Error"
        />
        <LanguageSwitch
          label="Language"
          value="en"
          action={() => {}}
          options={[
            { value: "en", short: "EN", name: "English" },
            { value: "hi", short: "हिं", name: "हिंदी" },
          ]}
        />
        <HelpTip label="Help" text="t" translation={{ text: "h", lang: "hi" }} />
        <ToastButtons />
        <Button onClick={() => setOverlays(true)}>Open overlays</Button>
        <Dialog
          title="Dialog"
          description="d"
          closeLabel="Close dialog"
          open={overlays}
          footer={<Button>Save</Button>}
        >
          body
        </Dialog>
        <ConfirmSheet
          title="Stop?"
          summary="It stops."
          confirmLabel="Stop"
          cancelLabel="Cancel"
          confirmIcon="danger"
          tone="danger"
          open={overlays}
          onConfirm={() => {}}
        />
      </div>
    </ToastProvider>
  );
}

/** The gallery opens overlays and types into the combobox: slower than one render on a busy CI box. */
const GALLERY_TIMEOUT = 30_000;

function collectClasses(into: Set<string>): void {
  for (const element of document.querySelectorAll("[class]")) {
    for (const name of element.classList) into.add(name);
  }
}

async function renderedClasses(): Promise<string[]> {
  render(<Gallery />);
  const classes = new Set<string>();
  // Radix modals set `pointer-events: none` on the body; the gallery opens them last anyway.
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  // Open one tooltip so its (portalled) classes are collected too.
  await user.hover(screen.getByRole("button", { name: "Print primary md" }));
  await screen.findByRole("tooltip");
  collectClasses(classes);
  // Combobox list with options (highlighted and not).
  await user.type(screen.getByRole("combobox", { name: "Find customer" }), "r");
  await screen.findByRole("option", { name: /Ramesh/ });
  collectClasses(classes);
  await user.keyboard("{Escape}");
  // HelpTip bubble.
  await user.click(screen.getByRole("button", { name: "Help" }));
  await screen.findByText("h");
  collectClasses(classes);
  await user.keyboard("{Escape}");
  // One toast of each variant.
  await user.click(screen.getByRole("button", { name: "Show toasts" }));
  await screen.findByText("Saved on phone");
  collectClasses(classes);
  // Dialog and ConfirmSheet.
  await user.click(screen.getByRole("button", { name: "Open overlays" }));
  await screen.findByText("It stops.");
  await screen.findByText("body");
  collectClasses(classes);
  for (const shared of [
    fieldBase,
    focusRing,
    focusWithinRing,
    dialogOverlayClasses,
    dialogPanelClasses,
  ]) {
    for (const name of shared.split(/\s+/)) classes.add(name);
  }
  return [...classes].sort();
}

describe("primitive and composite classes exist in the token theme", () => {
  it(
    "every rendered class compiles to CSS",
    async () => {
      const classes = await renderedClasses();
      expect(classes.length).toBeGreaterThan(80);
      const css = theme.candidatesToCss(classes);
      // `group` is a marker for `group-*` variants and has no CSS of its own.
      const markers = new Set(["group"]);
      const missing = classes.filter((name, index) => css[index] === null && !markers.has(name));
      expect(missing).toEqual([]);
    },
    GALLERY_TIMEOUT,
  );

  it("is not vacuous: stock names the theme removed produce nothing", () => {
    const removed = ["bg-white", "text-xs", "shadow-md", "bg-red-500", "font-bold", "rounded-3xl"];
    expect(stock.candidatesToCss(removed).every((css) => css !== null)).toBe(true);
    expect(theme.candidatesToCss(removed)).toEqual(removed.map(() => null));
  });

  it("the focus ring uses the focus token colour", () => {
    const [css] = theme.candidatesToCss(["focus-visible:outline-focus"]);
    expect(css).toContain("var(--color-focus)");
  });

  it(
    "no rendered class is a shadow or gradient",
    async () => {
      const classes = await renderedClasses();
      const css = theme.candidatesToCss(classes).join("\n");
      expect(css).not.toMatch(/box-shadow:\s*(?!var\(--tw-ring-offset-shadow\)|0 0 #0000)/);
      expect(css).not.toMatch(/gradient\(/);
    },
    GALLERY_TIMEOUT,
  );
});
