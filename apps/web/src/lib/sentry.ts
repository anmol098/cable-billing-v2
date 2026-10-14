/**
 * Options shared by the server, edge and browser Sentry SDKs (E-08).
 *
 * Customer names, phone numbers and amounts pass through requests and local variables, and auth
 * cookies carry sessions, so the SDK collects no user info, cookies, bodies, query strings,
 * DB query data or stack-frame variables. Stack traces, URLs paths and headers (minus secrets,
 * which Sentry always filters) are enough to debug.
 */
export const sentrySharedOptions = {
  tracesSampleRate: 0.1,
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpBodies: [],
    urlQueryParams: false,
    databaseQueryData: false,
    stackFrameVariables: false,
  },
};

/** The parts of the browser `@sentry/nextjs` SDK that `startBrowserSentry` uses. */
export type BrowserSentrySdk = Pick<
  typeof import("@sentry/nextjs"),
  "init" | "captureException" | "captureRouterTransitionStart"
>;

export type BrowserSentryOptions = {
  /** `NEXT_PUBLIC_SENTRY_DSN`. Without it nothing is loaded and nothing is listened to. */
  dsn: string | undefined;
  environment: string | undefined;
  /** Loads the SDK, normally `() => import("@sentry/nextjs")` (its own chunk). Called at most once. */
  load: () => Promise<BrowserSentrySdk>;
  /** The page's window (tests pass jsdom's). */
  target: Window;
};

/** Errors kept while the SDK loads. A page that throws more than this in its first seconds is broken anyway. */
export const EARLY_ERROR_LIMIT = 20;

type EarlyError = { error: unknown; type: "onerror" | "onunhandledrejection" };

/**
 * Browser Sentry, loaded after the page (T-087a). The SDK is ≈55 KB of compressed JavaScript; in
 * the page's own bundle every visitor downloaded and ran it before the page became usable, on
 * slow phone data too (PRD §11). Here it is a separate chunk, fetched once the page has loaded and
 * the browser is idle.
 *
 * Nothing is lost in the meantime: uncaught errors and unhandled promise rejections are kept from
 * the first line of client code and sent, marked unhandled like the SDK's own global handlers do,
 * as soon as the SDK has started. The pageload trace still starts at the navigation (the SDK reads
 * the browser's performance timeline). Router transitions before then are not traced.
 *
 * Returns the `onRouterTransitionStart` hook for `instrumentation-client.ts`.
 */
export function startBrowserSentry({
  dsn,
  environment,
  load,
  target,
}: BrowserSentryOptions): (href: string, navigationType: string) => void {
  if (!dsn) return () => {};

  let sdk: BrowserSentrySdk | undefined;
  const early: EarlyError[] = [];
  const keep = (entry: EarlyError) => {
    if (early.length < EARLY_ERROR_LIMIT) early.push(entry);
  };
  const onError = (event: ErrorEvent) =>
    keep({ error: event.error ?? event.message, type: "onerror" });
  const onRejection = (event: PromiseRejectionEvent) =>
    keep({ error: event.reason, type: "onunhandledrejection" });
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  const stopKeeping = () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };

  const start = async () => {
    let Sentry: BrowserSentrySdk;
    try {
      Sentry = await load();
    } catch {
      // The chunk failed to load (offline, a deploy in between): the page keeps working without it.
      stopKeeping();
      early.length = 0;
      return;
    }
    Sentry.init({ ...sentrySharedOptions, dsn, environment });
    // From here on the SDK's own global handlers catch errors, so ours stop.
    stopKeeping();
    sdk = Sentry;
    for (const { error, type } of early.splice(0)) {
      Sentry.captureException(error, {
        mechanism: { type: `auto.browser.global_handlers.${type}`, handled: false },
      });
    }
  };
  const startWhenIdle = () => {
    const run = () => void start();
    if (typeof target.requestIdleCallback === "function") {
      target.requestIdleCallback(run, { timeout: 3000 });
    } else {
      target.setTimeout(run, 1);
    }
  };
  if (target.document.readyState === "complete") startWhenIdle();
  else target.addEventListener("load", startWhenIdle, { once: true });

  return (href, navigationType) => sdk?.captureRouterTransitionStart(href, navigationType);
}
