import { type ComponentProps, createElement } from "react";
import { ICON_NODES, ICON_SVG_ATTRIBUTES, type IconName } from "./icons.generated";

export type { IconName } from "./icons.generated";

/** Every semantic icon name, in icons.json order. */
export const ICON_NAMES = Object.keys(ICON_NODES) as IconName[];

export function isIconName(value: string): value is IconName {
  return Object.hasOwn(ICON_NODES, value);
}

export type IconProps = Omit<ComponentProps<"svg">, "children" | "name"> & {
  /** Semantic name from `packages/design-tokens/icons.json`. */
  name: IconName;
  /**
   * Accessible name (an i18n string). Leave it out when a visible word sits next to the icon, as
   * PLAN §2.2 requires for actions: the icon is then hidden from screen readers.
   */
  label?: string;
};

/**
 * A Lucide outline icon drawn in `currentColor`, so its colour comes from the surrounding text
 * colour token (`text-cash`, `text-danger`, …). It is `1em` square by default, so it scales with the
 * type token of its text (`text-lg`); pass a spacing utility such as `className="size-6"` to size it
 * on its own.
 */
export function Icon({ name, label, ...props }: IconProps) {
  const a11y = label
    ? { role: "img", "aria-label": label }
    : { "aria-hidden": true as const, focusable: "false" };
  return createElement(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      width: "1em",
      height: "1em",
      ...ICON_SVG_ATTRIBUTES,
      "data-icon": name,
      ...a11y,
      ...props,
    },
    ICON_NODES[name].map(([tag, attributes], index) =>
      // Icon elements are static and never reorder, so the index is a stable key.
      createElement(tag, { key: index, ...attributes }),
    ),
  );
}
