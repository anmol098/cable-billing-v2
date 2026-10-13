/**
 * Pure parts of the job system: backoff, definitions, registry, error summaries, the Resend
 * transport. No database.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as core from "../index";
import {
  createRecordingEmailTransport,
  createResendEmailTransport,
  EmailSendError,
} from "./alerts";
import { backoffDelayMs } from "./backoff";
import {
  continueLater,
  defineJob,
  isContinueLater,
  isJobDefinition,
  PermanentJobError,
} from "./definition";
import { jobErrorSummary } from "./failure";
import { collectJobDefinitions, createJobRegistry } from "./registry";

const noop = async () => undefined;

describe("backoffDelayMs", () => {
  it("doubles per attempt with equal jitter, deterministic with an injected random", () => {
    const at = (attempt: number, r: number) =>
      backoffDelayMs(attempt, { baseMs: 1_000, maxMs: 60_000, random: () => r });
    expect([1, 2, 3, 4].map((n) => at(n, 0))).toEqual([500, 1_000, 2_000, 4_000]);
    expect([1, 2, 3, 4].map((n) => at(n, 0.5))).toEqual([750, 1_500, 3_000, 6_000]);
    expect(at(1, 0.999_999)).toBe(1_000);
  });

  it("caps at maxMs and never goes below half the step", () => {
    expect(backoffDelayMs(30, { baseMs: 1_000, maxMs: 60_000, random: () => 0 })).toBe(30_000);
    expect(backoffDelayMs(30, { baseMs: 1_000, maxMs: 60_000, random: () => 1 })).toBe(60_000);
    expect(backoffDelayMs(0, { baseMs: 1_000, random: () => 0 })).toBe(500);
    for (let i = 0; i < 200; i += 1) {
      const d = backoffDelayMs(3);
      expect(d).toBeGreaterThanOrEqual(60_000);
      expect(d).toBeLessThanOrEqual(120_000);
    }
  });
});

describe("defineJob", () => {
  it("validates the type, scope and maxAttempts and returns a frozen definition", () => {
    const payload = z.object({});
    expect(() => defineJob({ type: "nodots", scope: "tenant", payload, run: noop })).toThrow(
      TypeError,
    );
    expect(() => defineJob({ type: "a.B", scope: "tenant", payload, run: noop })).toThrow(
      TypeError,
    );
    expect(() =>
      // @ts-expect-error: unknown scope
      defineJob({ type: "a.b", scope: "global", payload, run: noop }),
    ).toThrow(TypeError);
    expect(() =>
      defineJob({ type: "a.b", scope: "tenant", payload, maxAttempts: 0, run: noop }),
    ).toThrow(TypeError);
    const job = defineJob({ type: "a.b", scope: "tenant", payload, run: noop });
    expect(isJobDefinition(job)).toBe(true);
    expect(Object.isFrozen(job)).toBe(true);
    expect(job.notifyOwner).toBe(true);
    expect(
      defineJob({ type: "a.c", scope: "tenant", payload, notifyOwner: false, run: noop })
        .notifyOwner,
    ).toBe(false);
    expect(defineJob({ type: "a.d", scope: "platform", payload, run: noop }).notifyOwner).toBe(
      false,
    );
  });

  it("continueLater and PermanentJobError", () => {
    expect(isContinueLater(continueLater({ payload: { cursor: 3 } }))).toBe(true);
    expect(isContinueLater(undefined)).toBe(false);
    expect(new PermanentJobError("gone").code).toBe("gone");
    expect(() => new PermanentJobError("Not Snake")).toThrow(TypeError);
  });
});

describe("registry", () => {
  const a = defineJob({ type: "tests.a", scope: "tenant", payload: z.object({}), run: noop });
  const b = defineJob({ type: "tests.b", scope: "platform", payload: z.object({}), run: noop });

  it("registers definitions by type and refuses a second handler for a type", () => {
    const registry = createJobRegistry([b]).register(a).registerJob("tests.a", a);
    expect(registry.types()).toEqual(["tests.a", "tests.b"]);
    expect(registry.get("tests.a")).toBe(a);
    expect(registry.has("tests.c")).toBe(false);
    const clash = defineJob({ type: "tests.a", scope: "tenant", payload: z.object({}), run: noop });
    expect(() => registry.register(clash)).toThrow(/registered twice/);
    expect(() => registry.registerJob("tests.x", a)).toThrow(TypeError);
    // @ts-expect-error: not a definition
    expect(() => registry.register({ type: "tests.z" })).toThrow(TypeError);
  });

  it("collects every definition a module exports (how the worker finds feature jobs)", () => {
    expect(collectJobDefinitions({ a, b, alsoA: a, other: 1, fn: noop })).toEqual([a, b]);
    const clash = defineJob({ type: "tests.a", scope: "tenant", payload: z.object({}), run: noop });
    expect(() => collectJobDefinitions({ a, clash })).toThrow(/defined twice/);
    // @cb/core itself exports no job definitions yet (feature tasks add them): this must not throw.
    expect(() => collectJobDefinitions(core)).not.toThrow();
  });
});

describe("jobErrorSummary (stored in jobs.last_error, sent in alerts)", () => {
  it("keeps type and a scrubbed message; drops database messages; names permanent codes", () => {
    expect(jobErrorSummary(new Error("boom"))).toBe("Error: boom");
    const scrubbed = jobErrorSummary(new Error("call 9876543210 or mail ravi@example.com"));
    expect(scrubbed).not.toContain("9876543210");
    expect(scrubbed).not.toContain("ravi@example.com");
    const dbError = Object.assign(new Error("Key (phone)=(9876543210) already exists"), {
      code: "23505",
      constraint: "customers_phone_unique",
    });
    expect(jobErrorSummary(dbError)).toBe("Error sqlstate=23505 constraint=customers_phone_unique");
    expect(jobErrorSummary(new PermanentJobError("invalid_payload"))).toBe(
      "permanent: invalid_payload",
    );
    expect(jobErrorSummary("x".repeat(2_000)).length).toBeLessThanOrEqual(500);
  });
});

describe("email transports", () => {
  it("Resend: POSTs the message with the API key and an idempotency key", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const transport = createResendEmailTransport({
      apiKey: "re_test_key",
      from: "Cable Billing <alerts@example.test>",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await transport.send({ to: "a@example.test", subject: "S", text: "T", idempotencyKey: "k1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer re_test_key",
      "Idempotency-Key": "k1",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      from: "Cable Billing <alerts@example.test>",
      to: ["a@example.test"],
      subject: "S",
      text: "T",
    });
  });

  it("Resend: a refused message throws with the status only (never the response body)", async () => {
    const transport = createResendEmailTransport({
      apiKey: "re_test_key",
      from: "x <a@example.test>",
      fetch: (async () =>
        new Response('{"message":"bad to: a@example.test"}', { status: 422 })) as typeof fetch,
    });
    const error = await transport.send({ to: "a@example.test", subject: "S", text: "T" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(EmailSendError);
    expect((error as EmailSendError).status).toBe(422);
    expect((error as Error).message).not.toContain("@");
  });

  it("the recording double keeps messages and can fail on purpose", async () => {
    const transport = createRecordingEmailTransport({ failFor: ["bad@example.test"] });
    await transport.send({ to: "ok@example.test", subject: "S", text: "T" });
    await expect(
      transport.send({ to: "bad@example.test", subject: "S", text: "T" }),
    ).rejects.toThrow(EmailSendError);
    expect(transport.sent.map((m) => m.to)).toEqual(["ok@example.test"]);
  });
});
