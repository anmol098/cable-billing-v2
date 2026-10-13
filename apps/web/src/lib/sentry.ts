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
