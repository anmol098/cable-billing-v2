/**
 * Contract round-trip tests over `fixtures/` (task T-051 "Tests required"): every fixture parses
 * with its Zod schema without losing or changing anything, survives a JSON round trip, and is valid
 * against the generated `openapi.json` too (what Android's DTOs come from).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import { ENDPOINT_LIST, ENDPOINTS } from "./endpoints";
import { ERROR_CODES } from "./errors";
import { describeFixture, FIXTURES_DIR, type Fixture, loadFixtures } from "./fixtures";
import type { JsonValue } from "./openapi";

const fixtures = loadFixtures();
const byFile = new Map(fixtures.map((fixture) => [fixture.file, fixture]));
const openapi = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "..", "openapi.json"), "utf8"),
) as Record<string, JsonValue>;

// ajv-formats is CommonJS; under ESM its default export may be wrapped.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as typeof addFormatsModule;

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(openapi, "openapi.json");

type Json = { [key: string]: JsonValue };

function at(value: JsonValue | undefined, ...keys: string[]): JsonValue | undefined {
  let current = value;
  for (const key of keys) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** The `$ref` of the JSON body schema an OpenAPI operation declares for a fixture. */
function openApiRef(fixture: Fixture): string {
  if (fixture.kind === "error") return "#/components/schemas/ErrorResponse";
  const endpoint = ENDPOINTS[fixture.operationId ?? "login"];
  const operation = at(openapi as Json, "paths", endpoint.path, endpoint.method);
  const media =
    fixture.kind === "request"
      ? at(operation, "requestBody", "content", "application/json", "schema", "$ref")
      : at(operation, "responses", "200", "content", "application/json", "schema", "$ref");
  if (typeof media !== "string") throw new Error(`${fixture.file}: no $ref in openapi.json`);
  return media;
}

function validateWithOpenApi(fixture: Fixture, value: unknown) {
  const validate = ajv.getSchema(`openapi.json${openApiRef(fixture)}`);
  if (!validate) throw new Error(`${fixture.file}: schema not found`);
  const valid = validate(value);
  return { valid, errors: validate.errors };
}

describe("fixtures: coverage", () => {
  it("has a main response fixture for every endpoint, and a request fixture for every body", () => {
    for (const endpoint of ENDPOINT_LIST) {
      expect(byFile.has(`${endpoint.operationId}.response.json`), endpoint.operationId).toBe(true);
      expect(byFile.has(`${endpoint.operationId}.request.json`), endpoint.operationId).toBe(
        endpoint.body !== undefined,
      );
    }
  });

  it("has an error fixture for every error code, with that code", () => {
    for (const code of ERROR_CODES) {
      const fixture = byFile.get(`error.${code}.json`);
      expect(fixture, code).toBeDefined();
      expect(at(fixture?.value, "error", "code")).toBe(code);
    }
  });

  it("refuses fixture names that fit no rule", () => {
    expect(() => describeFixture("nope.response.json", {})).toThrow(/not <operationId>/);
    expect(() => describeFixture("getAppConfig.request.json", {})).toThrow(/no request body/);
    expect(() => describeFixture("error.NOT_A_CODE.json", {})).toThrow(/unknown error code/);
  });

  it("covers every payment and receipt-action outcome", () => {
    const payments = at(byFile.get("postPaymentBatch.response.json")?.value, "results");
    const outcomes = Array.isArray(payments) ? payments.map((r) => at(r, "outcome")) : [];
    expect(new Set(outcomes)).toEqual(
      new Set(["posted", "duplicate", "posted_needs_review", "rejected", "retry_later"]),
    );
    const actions = at(byFile.get("postReceiptActions.response.json")?.value, "results");
    expect(Array.isArray(actions) ? actions.length : 0).toBeGreaterThan(0);
  });

  it("answers each batch item in request order, matched by id", () => {
    const pairs = [
      ["postPaymentBatch", "payments"],
      ["postReceiptActions", "actions"],
    ] as const;
    for (const [operationId, key] of pairs) {
      const request = at(byFile.get(`${operationId}.request.json`)?.value, key);
      const results = at(byFile.get(`${operationId}.response.json`)?.value, "results");
      const ids = (list: JsonValue | undefined) =>
        Array.isArray(list) ? list.map((entry) => at(entry, "id")) : [];
      expect(ids(results), operationId).toEqual(ids(request));
    }
  });
});

describe.each(fixtures.map((fixture) => [fixture.file, fixture] as const))(
  "%s",
  (_file, fixture) => {
    it("parses with its Zod schema without losing or changing anything", () => {
      const result = fixture.schema.safeParse(fixture.value);
      expect(result.error?.issues ?? []).toEqual([]);
      expect(result.data).toEqual(fixture.value);
    });

    it("survives a JSON round trip", () => {
      const parsed = fixture.schema.parse(fixture.value);
      const again = fixture.schema.parse(JSON.parse(JSON.stringify(parsed)));
      expect(again).toEqual(parsed);
    });

    it("is valid against openapi.json", () => {
      const { valid, errors } = validateWithOpenApi(fixture, fixture.value);
      expect(errors ?? []).toEqual([]);
      expect(valid).toBe(true);
    });
  },
);

describe("openapi.json is as strict as the Zod schemas on the basics", () => {
  const login = byFile.get("login.response.json") as Fixture;
  const batch = byFile.get("postPaymentBatch.request.json") as Fixture;
  const clone = <T>(value: T): T => structuredClone(value);

  it("rejects a fractional amount (money is integer paise)", () => {
    const value = clone(batch.value) as Json;
    const first = (value.payments as Json[])[0] as Json;
    first.amount_paise = 500.5;
    expect(validateWithOpenApi(batch, value).valid).toBe(false);
    expect(batch.schema.safeParse(value).success).toBe(false);
  });

  it("rejects a time with an offset other than Z (times are UTC)", () => {
    const value = clone(batch.value) as Json;
    const first = (value.payments as Json[])[0] as Json;
    first.recorded_at = "2026-10-13T06:45:00.000+05:30";
    expect(validateWithOpenApi(batch, value).valid).toBe(false);
    expect(batch.schema.safeParse(value).success).toBe(false);
  });

  it("rejects an id that is not a UUID", () => {
    const value = clone(login.value) as Json;
    (value.user as Json).id = "1045";
    expect(validateWithOpenApi(login, value).valid).toBe(false);
    expect(login.schema.safeParse(value).success).toBe(false);
  });

  it("rejects a missing required field", () => {
    const value = clone(login.value) as Json;
    delete value.server_time;
    expect(validateWithOpenApi(login, value).valid).toBe(false);
    expect(login.schema.safeParse(value).success).toBe(false);
  });

  it("accepts unknown response fields (additive changes within v1)", () => {
    const value = clone(login.value) as Json;
    value.added_in_v1_1 = "ignored by older apps";
    expect(validateWithOpenApi(login, value).valid).toBe(true);
    expect(login.schema.safeParse(value).success).toBe(true);
  });
});
