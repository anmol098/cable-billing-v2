import { describe, expect, it, vi } from "vitest";
import {
  type BrowserSentrySdk,
  EARLY_ERROR_LIMIT,
  sentrySharedOptions,
  startBrowserSentry,
} from "./sentry";

const DSN = "https://public@o1.ingest.sentry.io/1";

/** A window stand-in: real events, a controllable `readyState`, and idle callbacks run by hand. */
function fakeWindow(readyState: DocumentReadyState = "complete") {
  const target = new EventTarget();
  const idle: Array<() => void> = [];
  const win = Object.assign(target, {
    document: { readyState },
    requestIdleCallback: vi.fn((callback: () => void) => {
      idle.push(callback);
      return idle.length;
    }),
    setTimeout: vi.fn(),
  });
  const runIdle = () => {
    for (const callback of idle.splice(0)) callback();
  };
  return { win: win as unknown as Window, idle, runIdle };
}

function fakeSdk() {
  return {
    init: vi.fn(),
    captureException: vi.fn(() => "event-id"),
    captureRouterTransitionStart: vi.fn(),
  } satisfies Record<keyof BrowserSentrySdk, unknown>;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function throwOn(win: Window, error: Error) {
  win.dispatchEvent(new ErrorEvent("error", { error, message: error.message }));
}

function rejectOn(win: Window, reason: unknown) {
  win.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason }));
}

describe("startBrowserSentry", () => {
  it("does nothing without a DSN: no SDK download, no listeners", () => {
    const { win } = fakeWindow();
    const listen = vi.spyOn(win, "addEventListener");
    const load = vi.fn();
    const hook = startBrowserSentry({ dsn: undefined, environment: "test", load, target: win });
    hook("/home", "push");
    expect(load).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
    expect(win.requestIdleCallback).not.toHaveBeenCalled();
  });

  it("loads the SDK only once the page has loaded and the browser is idle", async () => {
    const { win, idle, runIdle } = fakeWindow("loading");
    const sdk = fakeSdk();
    const load = vi.fn(async () => sdk);
    startBrowserSentry({ dsn: DSN, environment: "preview", load, target: win });

    expect(idle).toHaveLength(0);
    win.dispatchEvent(new Event("load"));
    expect(idle).toHaveLength(1);
    expect(load).not.toHaveBeenCalled();

    runIdle();
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(sdk.init).toHaveBeenCalledTimes(1);
  });

  it("starts the SDK with the E-08 privacy settings, the DSN and the environment", async () => {
    const { win, runIdle } = fakeWindow();
    const sdk = fakeSdk();
    startBrowserSentry({ dsn: DSN, environment: "preview", load: async () => sdk, target: win });
    runIdle();
    await flush();

    expect(sdk.init).toHaveBeenCalledWith({
      ...sentrySharedOptions,
      dsn: DSN,
      environment: "preview",
    });
    const options = sdk.init.mock.calls[0]?.[0];
    expect(options.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
    });
  });

  it("sends errors thrown before the SDK loaded, marked unhandled, then leaves errors to the SDK", async () => {
    const { win, runIdle } = fakeWindow();
    const sdk = fakeSdk();
    startBrowserSentry({ dsn: DSN, environment: "test", load: async () => sdk, target: win });

    const early = new Error("thrown while the page hydrated");
    throwOn(win, early);
    rejectOn(win, "rejected early");
    expect(sdk.captureException).not.toHaveBeenCalled();

    runIdle();
    await flush();
    expect(sdk.captureException).toHaveBeenCalledTimes(2);
    expect(sdk.captureException).toHaveBeenNthCalledWith(1, early, {
      mechanism: { type: "auto.browser.global_handlers.onerror", handled: false },
    });
    expect(sdk.captureException).toHaveBeenNthCalledWith(2, "rejected early", {
      mechanism: { type: "auto.browser.global_handlers.onunhandledrejection", handled: false },
    });
    // Sent after init, so they go through the configured client.
    expect(sdk.init.mock.invocationCallOrder[0]).toBeLessThan(
      sdk.captureException.mock.invocationCallOrder[0] ?? 0,
    );

    // Later errors are the SDK's own global handlers' job: not sent twice.
    throwOn(win, new Error("after start"));
    await flush();
    expect(sdk.captureException).toHaveBeenCalledTimes(2);
  });

  it("keeps at most a bounded number of early errors", async () => {
    const { win, runIdle } = fakeWindow();
    const sdk = fakeSdk();
    startBrowserSentry({ dsn: DSN, environment: "test", load: async () => sdk, target: win });
    for (let i = 0; i < EARLY_ERROR_LIMIT + 5; i++) throwOn(win, new Error(`e${i}`));
    runIdle();
    await flush();
    expect(sdk.captureException).toHaveBeenCalledTimes(EARLY_ERROR_LIMIT);
  });

  it("forwards router transitions once the SDK has started, and ignores them before", async () => {
    const { win, runIdle } = fakeWindow();
    const sdk = fakeSdk();
    const hook = startBrowserSentry({
      dsn: DSN,
      environment: "test",
      load: async () => sdk,
      target: win,
    });
    hook("/customers", "push");
    runIdle();
    await flush();
    hook("/payments", "replace");
    expect(sdk.captureRouterTransitionStart).toHaveBeenCalledTimes(1);
    expect(sdk.captureRouterTransitionStart).toHaveBeenCalledWith("/payments", "replace");
  });

  it("keeps the page working when the SDK chunk cannot be loaded", async () => {
    const { win, runIdle } = fakeWindow();
    const remove = vi.spyOn(win, "removeEventListener");
    const hook = startBrowserSentry({
      dsn: DSN,
      environment: "test",
      load: () => Promise.reject(new Error("ChunkLoadError")),
      target: win,
    });
    runIdle();
    await flush();
    expect(remove).toHaveBeenCalledWith("error", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("unhandledrejection", expect.any(Function));
    expect(() => hook("/home", "push")).not.toThrow();
  });

  it("falls back to a timer where requestIdleCallback is missing (Safari)", async () => {
    const { win } = fakeWindow();
    Object.assign(win, { requestIdleCallback: undefined });
    const sdk = fakeSdk();
    startBrowserSentry({ dsn: DSN, environment: "test", load: async () => sdk, target: win });
    const timer = vi.mocked(win.setTimeout);
    expect(timer).toHaveBeenCalledTimes(1);
    const [callback] = timer.mock.calls[0] ?? [];
    (callback as () => void)();
    await flush();
    expect(sdk.init).toHaveBeenCalledTimes(1);
  });
});
