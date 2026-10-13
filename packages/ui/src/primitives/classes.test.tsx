// @vitest-environment jsdom
import { join } from "node:path";
import { __unstable__loadDesignSystem } from "@tailwindcss/node";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";
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
    </div>
  );
}

async function renderedClasses(): Promise<string[]> {
  render(<Gallery />);
  // Open one tooltip so its (portalled) classes are collected too.
  await userEvent.setup().hover(screen.getByRole("button", { name: "Print primary md" }));
  await screen.findByRole("tooltip");
  const classes = new Set<string>();
  for (const element of document.querySelectorAll("[class]")) {
    for (const name of element.classList) classes.add(name);
  }
  for (const shared of [fieldBase, focusRing, focusWithinRing]) {
    for (const name of shared.split(/\s+/)) classes.add(name);
  }
  return [...classes].sort();
}

describe("primitive classes exist in the token theme", () => {
  it("every rendered class compiles to CSS", async () => {
    const classes = await renderedClasses();
    expect(classes.length).toBeGreaterThan(80);
    const css = theme.candidatesToCss(classes);
    // `group` is a marker for `group-*` variants and has no CSS of its own.
    const markers = new Set(["group"]);
    const missing = classes.filter((name, index) => css[index] === null && !markers.has(name));
    expect(missing).toEqual([]);
  });

  it("is not vacuous: stock names the theme removed produce nothing", () => {
    const removed = ["bg-white", "text-xs", "shadow-md", "bg-red-500", "font-bold", "rounded-3xl"];
    expect(stock.candidatesToCss(removed).every((css) => css !== null)).toBe(true);
    expect(theme.candidatesToCss(removed)).toEqual(removed.map(() => null));
  });

  it("the focus ring uses the focus token colour", () => {
    const [css] = theme.candidatesToCss(["focus-visible:outline-focus"]);
    expect(css).toContain("var(--color-focus)");
  });

  it("no rendered class is a shadow or gradient", async () => {
    const classes = await renderedClasses();
    const css = theme.candidatesToCss(classes).join("\n");
    expect(css).not.toMatch(/box-shadow:\s*(?!var\(--tw-ring-offset-shadow\)|0 0 #0000)/);
    expect(css).not.toMatch(/gradient\(/);
  });
});
