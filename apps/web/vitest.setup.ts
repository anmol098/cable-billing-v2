import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest globals are off, so Testing Library cannot register its own cleanup.
afterEach(() => {
  cleanup();
});

// findBy*/waitFor give up after 1 s by default; Radix overlays (tooltips, dialogs) can take longer to
// appear on a busy machine or CI runner. 5 s keeps real failures fast enough to diagnose.
configure({ asyncUtilTimeout: 5_000 });
