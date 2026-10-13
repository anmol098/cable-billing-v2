import { fileURLToPath } from "node:url";
import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
// Importing the env module validates it: `next build` / `next start` stop on a bad variable.
import { assertDeploymentEnv, clientEnv, serverEnv } from "./src/env";
import { securityHeaders } from "./src/lib/security-headers";

// A production build also stops when a variable production needs is missing (T-011), so a
// half-configured deploy never goes live. Previews are checked when a server boots instead.
if (serverEnv.VERCEL_ENV === "production") assertDeploymentEnv({ ...serverEnv, ...clientEnv });

/** The pnpm workspace root, so Turbopack and file tracing see packages/* (and no outer lockfile). */
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `next dev` would otherwise write an AGENTS.md here (same choice as turbo's agentGuidance).
  // Version-accurate Next.js docs live in apps/web/node_modules/next/dist/docs/.
  agentRules: false,
  // Workspace libraries are TypeScript source (no dist); Next.js compiles them. Add new @cb/* deps here.
  transpilePackages: ["@cb/core", "@cb/db", "@cb/domain", "@cb/i18n", "@cb/ui"],
  turbopack: { root: workspaceRoot },
  outputFileTracingRoot: workspaceRoot,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders({
          isDev: process.env.NODE_ENV === "development",
          sentryDsn: clientEnv.NEXT_PUBLIC_SENTRY_DSN,
        }),
      },
    ];
  },
};

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

export default withSentryConfig(withNextIntl(nextConfig), {
  // Source maps are uploaded only when a token is configured (H-01); otherwise the build is offline.
  org: serverEnv.SENTRY_ORG,
  project: serverEnv.SENTRY_PROJECT,
  authToken: serverEnv.SENTRY_AUTH_TOKEN,
  sourcemaps: { disable: !serverEnv.SENTRY_AUTH_TOKEN },
  silent: !process.env.CI,
  telemetry: false,
});
