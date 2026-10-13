/* Test-only helpers for the primitives. Not exported from the package. */
import axe from "axe-core";

/**
 * Runs axe (WCAG 2.0–2.2 A/AA rules) on a rendered subtree and returns readable violations, so a
 * failing test prints `rule: help (selector)`. Colour contrast is off because jsdom does no CSS
 * layout or cascade; the token colours' contrast is a design-token concern.
 */
export async function axeViolations(container: Element = document.body): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  return results.violations.flatMap((violation) =>
    violation.nodes.map((node) => `${violation.id}: ${violation.help} (${node.target.join(" ")})`),
  );
}
