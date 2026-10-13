/* Vitest setup for @cb/ui component tests (jsdom). Not exported from the package. */
import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

// findBy*/waitFor give up after 1 s by default; Radix overlays (tooltips, dialogs) can take longer to
// appear on a busy machine or CI runner. 5 s keeps real failures fast enough to diagnose.
configure({ asyncUtilTimeout: 5_000 });

// Radix Toast's swipe handling uses pointer capture, which jsdom does not implement.
if (typeof Element !== "undefined" && !("hasPointerCapture" in Element.prototype)) {
  Object.assign(Element.prototype, {
    hasPointerCapture: () => false,
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  });
}

// Radix Tooltip measures its trigger with ResizeObserver, which jsdom does not implement.
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
