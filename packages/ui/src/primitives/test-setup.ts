/* Vitest setup for @cb/ui component tests (jsdom). Not exported from the package. */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

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
