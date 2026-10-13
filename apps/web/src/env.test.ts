import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type AppEnv,
  assertDeploymentEnv,
  clientSchema,
  deploymentEnvProblems,
  deploymentTarget,
  EnvError,
  parseEnv,
  REQUIRED_IN_PREVIEW,
  REQUIRED_IN_PRODUCTION,
  requireEnv,
  resolveBaseUrls,
  serverEnv,
  serverSchema,
} from "./env";

// `.href`: under jsdom the global URL is jsdom's, which node:fs does not accept as a path.
const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url).href), "utf8");

/** Minimal dotenv reader: `KEY=value` lines, optional surrounding quotes, `#` comments. */
function parseDotenv(text: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, key = "", raw = ""] = match;
    entries[key] = raw.replace(/^(["'])(.*)\1$/, "$2");
  }
  return entries;
}

const envExampleText = read("../.env.example");
const envExample = parseDotenv(envExampleText);
const serverKeys = Object.keys(serverSchema.shape);
const clientKeys = Object.keys(clientSchema.shape);
const allKeys = [...serverKeys, ...clientKeys];

/** Parses a full app environment (server + client) the way the app does. */
const appEnv = (source: Record<string, string | undefined>): AppEnv => ({
  ...parseEnv(serverSchema, source, "server"),
  ...parseEnv(clientSchema, source, "client"),
});

/** A complete, valid production environment (all values fake). */
const production: Record<string, string> = {
  VERCEL_ENV: "production",
  DATABASE_URL:
    "postgresql://app:pw@ep-x-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require",
  BETTER_AUTH_SECRET: "a".repeat(44),
  APP_BASE_URL: "https://app.example.test",
  CRON_SECRET: "c".repeat(64),
  RESEND_API_KEY: "re_fake",
  EMAIL_FROM: "Cable Billing <noreply@example.test>",
  TURNSTILE_SECRET_KEY: "0x4AAAAAAAfakefakefakefakefakefake",
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: "0x4AAAAAAAfakefake",
  UPSTASH_REDIS_REST_URL: "https://fake.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "token",
  RAZORPAY_KEY_ID: "rzp_live_Fake123",
  RAZORPAY_KEY_SECRET: "secret",
  RAZORPAY_WEBHOOK_SECRET: "w".repeat(64),
  RAZORPAY_PLAN_ID: "plan_Fake123",
  SENTRY_DSN: "https://key@o1.ingest.sentry.io/42",
  NEXT_PUBLIC_SENTRY_DSN: "https://key@o1.ingest.sentry.io/42",
};

describe("env schema", () => {
  it("accepts an empty environment (the build needs no env)", () => {
    expect(parseEnv(serverSchema, {}, "server")).toEqual({ NODE_ENV: "development" });
    expect(parseEnv(clientSchema, {}, "client")).toEqual({});
    const empty = appEnv({});
    expect(deploymentEnvProblems(empty)).toEqual([]);
    expect(() => assertDeploymentEnv(empty)).not.toThrow();
  });

  it("treats empty strings as unset", () => {
    const env = parseEnv(
      serverSchema,
      { SENTRY_DSN: "", VERCEL_ENV: "", CRON_SECRET: "" },
      "server",
    );
    expect(env.SENTRY_DSN).toBeUndefined();
    expect(env.VERCEL_ENV).toBeUndefined();
    expect(env.CRON_SECRET).toBeUndefined();
  });

  it("parses valid values", () => {
    const env = appEnv(production);
    expect(env).toMatchObject({ NODE_ENV: "development", VERCEL_ENV: "production" });
    expect(env.SENTRY_DSN).toBe("https://key@o1.ingest.sentry.io/42");
    expect(env.RAZORPAY_PLAN_ID).toBe("plan_Fake123");
  });

  it("normalises base URLs to an origin and rejects paths", () => {
    expect(parseEnv(serverSchema, { APP_BASE_URL: "https://x.test/" }, "server").APP_BASE_URL).toBe(
      "https://x.test",
    );
    expect(() => parseEnv(serverSchema, { APP_BASE_URL: "https://x.test/app" }, "server")).toThrow(
      /APP_BASE_URL: must be an origin only/,
    );
    expect(() => parseEnv(serverSchema, { RECEIPT_BASE_URL: "ftp://x.test" }, "server")).toThrow(
      /RECEIPT_BASE_URL/,
    );
  });

  it.each([
    ["DATABASE_URL", "mysql://u:p@localhost/db"],
    ["DATABASE_URL_UNPOOLED", "not a url"],
    ["BETTER_AUTH_SECRET", "too-short"],
    ["RESEND_API_KEY", "sk_wrong_prefix"],
    ["EMAIL_FROM", "Cable Billing"],
    ["UPSTASH_REDIS_REST_URL", "http://insecure.upstash.io"],
    ["CRON_SECRET", "short"],
    ["RAZORPAY_KEY_ID", "key_123"],
    ["RAZORPAY_WEBHOOK_SECRET", "short"],
    ["RAZORPAY_PLAN_ID", "123"],
    ["VERCEL_URL", "https://with-protocol.vercel.app"],
    ["VERCEL_ENV", "staging"],
  ])("rejects a bad %s with an EnvError naming it", (key, value) => {
    const run = () => parseEnv(serverSchema, { [key]: value }, "server");
    expect(run).toThrow(EnvError);
    expect(run).toThrow(new RegExp(`- ${key}: `));
  });

  it("fails fast with every bad variable named, without echoing values", () => {
    const run = () =>
      parseEnv(
        serverSchema,
        { SENTRY_DSN: "not a url", VERCEL_ENV: "staging-secret", BETTER_AUTH_SECRET: "hunter2" },
        "server",
      );
    expect(run).toThrow(EnvError);
    expect(run).toThrow(/SENTRY_DSN/);
    expect(run).toThrow(/VERCEL_ENV/);
    expect(run).toThrow(/BETTER_AUTH_SECRET/);
    expect(run).not.toThrow(/staging-secret|hunter2/);
  });

  it("requires paired variables together", () => {
    expect(() =>
      parseEnv(serverSchema, { UPSTASH_REDIS_REST_URL: "https://x.upstash.io" }, "server"),
    ).toThrow(/UPSTASH_REDIS_REST_TOKEN: must be set together with UPSTASH_REDIS_REST_URL/);
    expect(() => parseEnv(serverSchema, { RAZORPAY_KEY_SECRET: "s" }, "server")).toThrow(
      /RAZORPAY_KEY_ID: must be set together with RAZORPAY_KEY_SECRET/,
    );
  });

  it("validates client variables separately", () => {
    expect(() => parseEnv(clientSchema, { NEXT_PUBLIC_SENTRY_DSN: "nope" }, "client")).toThrow(
      /Invalid client environment variables/,
    );
  });

  it("guards serverEnv in the browser (this suite runs in jsdom)", () => {
    expect(() => serverEnv.DATABASE_URL).toThrow(/read in the browser/);
  });
});

describe(".env.example", () => {
  it("only lists variables the schema validates", () => {
    const unknown = Object.keys(envExample).filter((key) => !allKeys.includes(key));
    expect(unknown).toEqual([]);
  });

  it("mentions every variable the schema reads", () => {
    const missing = allKeys.filter(
      (key) => !new RegExp(`^#?\\s*${key}=`, "m").test(envExampleText),
    );
    expect(missing).toEqual([]);
  });

  it("is itself a valid local environment", () => {
    const env = appEnv(envExample);
    expect(deploymentTarget(env)).toBe("local");
    expect(deploymentEnvProblems(env)).toEqual([]);
  });

  it("marks exactly the production-required variables with [prod]", () => {
    const lines = envExampleText.split("\n");
    const marked = Object.keys(envExample).filter((key) => {
      const index = lines.findIndex((line) => line.startsWith(`${key}=`));
      return /\[prod\]/.test(lines[index - 1] ?? "") || /\[prod\]/.test(lines[index - 2] ?? "");
    });
    expect(marked.sort()).toEqual([...REQUIRED_IN_PRODUCTION].sort());
  });
});

describe("turbo.json", () => {
  it("lets every variable through to `next build` (turbo runs in strict env mode)", () => {
    const turbo = JSON.parse(read("../turbo.json")) as {
      tasks: { build: { env: string[]; passThroughEnv: string[] } };
    };
    const { env, passThroughEnv } = turbo.tasks.build;
    const listed = (key: string) =>
      env.includes(key) ||
      passThroughEnv.includes(key) ||
      (key.startsWith("NEXT_PUBLIC_") && env.includes("NEXT_PUBLIC_*"));
    // NODE_ENV is set by Next.js itself.
    const missing = allKeys.filter((key) => key !== "NODE_ENV" && !listed(key));
    expect(missing).toEqual([]);
  });
});

describe("deployment presence rules", () => {
  it("a complete production environment has no problems", () => {
    expect(deploymentEnvProblems(appEnv(production))).toEqual([]);
  });

  it("production lists every missing variable at once", () => {
    const env = appEnv({ VERCEL_ENV: "production" });
    expect(deploymentEnvProblems(env)).toEqual(
      REQUIRED_IN_PRODUCTION.map((key) => `${key}: required in production`),
    );
    expect(() => assertDeploymentEnv(env)).toThrow(/Environment is not ready for production/);
  });

  it("preview needs only the core variables", () => {
    const env = appEnv({ VERCEL_ENV: "preview" });
    expect(deploymentEnvProblems(env)).toEqual(
      REQUIRED_IN_PREVIEW.map((key) => `${key}: required in preview`),
    );
    const ready = appEnv({
      VERCEL_ENV: "preview",
      DATABASE_URL: production.DATABASE_URL,
      BETTER_AUTH_SECRET: production.BETTER_AUTH_SECRET,
    });
    expect(deploymentEnvProblems(ready)).toEqual([]);
  });

  it("`vercel dev` (VERCEL_ENV=development) counts as local", () => {
    expect(deploymentEnvProblems(appEnv({ VERCEL_ENV: "development" }))).toEqual([]);
  });

  it("never allows live Razorpay keys outside production", () => {
    const env = appEnv({
      VERCEL_ENV: "preview",
      DATABASE_URL: production.DATABASE_URL,
      BETTER_AUTH_SECRET: production.BETTER_AUTH_SECRET,
      RAZORPAY_KEY_ID: "rzp_live_Fake123",
      RAZORPAY_KEY_SECRET: "secret",
    });
    expect(deploymentEnvProblems(env)).toEqual([
      "RAZORPAY_KEY_ID: only production may use live-mode keys; use rzp_test_…",
    ]);
  });

  it("rejects test keys, http URLs and the sandbox sender in production", () => {
    const env = appEnv({
      ...production,
      RAZORPAY_KEY_ID: "rzp_test_Fake123",
      TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      APP_BASE_URL: "http://app.example.test",
      EMAIL_FROM: "Cable Billing <onboarding@resend.dev>",
    });
    expect(deploymentEnvProblems(env)).toEqual([
      "RAZORPAY_KEY_ID: production must use live-mode keys (rzp_live_…)",
      "TURNSTILE_SECRET_KEY: production must not use a Cloudflare test key",
      "NEXT_PUBLIC_TURNSTILE_SITE_KEY: production must not use a Cloudflare test key",
      "APP_BASE_URL: production must use https",
      "EMAIL_FROM: production must send from your own verified domain",
    ]);
  });
});

describe("requireEnv", () => {
  it("returns the requested variables", () => {
    const env = appEnv({ CRON_SECRET: "c".repeat(16) });
    expect(requireEnv(env, ["CRON_SECRET"])).toEqual({ CRON_SECRET: "c".repeat(16) });
  });

  it("names every missing variable", () => {
    expect(() => requireEnv(appEnv({}), ["DATABASE_URL", "BETTER_AUTH_SECRET"])).toThrow(
      /Missing environment variable\(s\): DATABASE_URL, BETTER_AUTH_SECRET/,
    );
  });
});

describe("resolveBaseUrls", () => {
  it("uses APP_BASE_URL and defaults the receipt origin to it", () => {
    expect(resolveBaseUrls({ APP_BASE_URL: "https://app.example.test" })).toEqual({
      app: "https://app.example.test",
      receipt: "https://app.example.test",
    });
    expect(
      resolveBaseUrls({ APP_BASE_URL: "https://a.test", RECEIPT_BASE_URL: "https://r.test" }),
    ).toEqual({ app: "https://a.test", receipt: "https://r.test" });
  });

  it("falls back to the branch URL on previews, then the deployment URL", () => {
    expect(
      resolveBaseUrls({
        VERCEL_ENV: "preview",
        VERCEL_BRANCH_URL: "web-git-x.vercel.app",
        VERCEL_URL: "web-abc.vercel.app",
      }).app,
    ).toBe("https://web-git-x.vercel.app");
    expect(resolveBaseUrls({ VERCEL_ENV: "preview", VERCEL_URL: "web-abc.vercel.app" }).app).toBe(
      "https://web-abc.vercel.app",
    );
  });

  it("falls back to localhost off Vercel and refuses to guess in production", () => {
    expect(resolveBaseUrls({}).app).toBe("http://localhost:3000");
    expect(() => resolveBaseUrls({ VERCEL_ENV: "production" })).toThrow(EnvError);
  });
});
