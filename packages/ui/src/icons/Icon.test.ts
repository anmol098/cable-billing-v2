import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ICON_NAMES, Icon, type IconProps, isIconName } from "./index";

const render = (props: IconProps) => renderToStaticMarkup(createElement(Icon, props));

describe("Icon", () => {
  it("draws a Lucide outline in currentColor, 1em square, hidden from screen readers", () => {
    expect(render({ name: "cash" })).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" ' +
        'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
        'stroke-linejoin="round" data-icon="cash" aria-hidden="true" focusable="false">' +
        '<rect width="20" height="12" x="2" y="6" rx="2"></rect>' +
        '<circle cx="12" cy="12" r="2"></circle>' +
        '<path d="M6 12h.01M18 12h.01"></path></svg>',
    );
  });

  it("gets an accessible name from label", () => {
    const html = render({ name: "success", label: "Done" });
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Done"');
    expect(html).not.toContain("aria-hidden");
  });

  it("passes other props through (className, size overrides)", () => {
    const html = render({ name: "danger", className: "size-6 text-danger", width: 32 });
    expect(html).toContain('class="size-6 text-danger"');
    expect(html).toContain('width="32"');
  });

  it("knows every name in icons.json, in order, and each draws something", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../../design-tokens/icons.json", import.meta.url), "utf8"),
    ) as Record<string, string>;
    expect(ICON_NAMES).toEqual(Object.keys(manifest));
    for (const name of ICON_NAMES) {
      expect(render({ name })).toMatch(/<(path|circle|rect|line|polyline|polygon|ellipse) /);
    }
  });

  it("never hard-codes a colour", () => {
    for (const name of ICON_NAMES) expect(render({ name })).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("isIconName narrows strings", () => {
    expect(isIconName("whatsapp")).toBe(true);
    expect(isIconName("toString")).toBe(false);
    expect(isIconName("nope")).toBe(false);
  });
});
