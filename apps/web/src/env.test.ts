import { describe, expect, it } from "vitest";
import { clientSchema, EnvError, parseEnv, serverSchema } from "./env";

describe("env", () => {
  it("accepts an empty environment (the build needs no env)", () => {
    expect(parseEnv(serverSchema, {}, "server")).toEqual({ NODE_ENV: "development" });
    expect(parseEnv(clientSchema, {}, "client")).toEqual({});
  });

  it("treats empty strings as unset", () => {
    const env = parseEnv(serverSchema, { SENTRY_DSN: "", VERCEL_ENV: "" }, "server");
    expect(env.SENTRY_DSN).toBeUndefined();
    expect(env.VERCEL_ENV).toBeUndefined();
  });

  it("parses valid values", () => {
    const env = parseEnv(
      serverSchema,
      {
        NODE_ENV: "production",
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_SHA: "abc123",
        SENTRY_DSN: "https://key@o1.ingest.sentry.io/42",
      },
      "server",
    );
    expect(env).toMatchObject({ NODE_ENV: "production", VERCEL_ENV: "preview" });
    expect(env.SENTRY_DSN).toBe("https://key@o1.ingest.sentry.io/42");
  });

  it("fails fast with every bad variable named, without echoing values", () => {
    const run = () =>
      parseEnv(serverSchema, { SENTRY_DSN: "not a url", VERCEL_ENV: "staging-secret" }, "server");
    expect(run).toThrow(EnvError);
    expect(run).toThrow(/SENTRY_DSN/);
    expect(run).toThrow(/VERCEL_ENV/);
    expect(run).not.toThrow(/staging-secret/);
  });

  it("validates client variables separately", () => {
    expect(() => parseEnv(clientSchema, { NEXT_PUBLIC_SENTRY_DSN: "nope" }, "client")).toThrow(
      /Invalid client environment variables/,
    );
  });
});
