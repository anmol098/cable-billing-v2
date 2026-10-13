/**
 * The JSON fixtures in `packages/contracts/fixtures/`: one example body per request and response
 * (plus variants) and one error body per error code. They are validated by the contract tests,
 * embedded as examples in `openapi.json`, and decoded by the Android tests (T-063, T-064, T-066).
 *
 * File names:
 * - `<operationId>.request.json` / `<operationId>.response.json`: the main examples.
 * - `<operationId>.request.<variant>.json` / `<operationId>.response.<variant>.json`: more cases.
 * - `error.<ERROR_CODE>.json`: an ErrorResponse with that code.
 *
 * Node-only (reads files). Not exported from the package entry, so app bundles never include it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as z from "zod";
import { ENDPOINTS, type OperationId } from "./endpoints";
import { type ErrorCode, ErrorResponse, isErrorCode } from "./errors";
import type { BuildOpenApiOptions, JsonValue } from "./openapi";

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export type Fixture = {
  /** File name, e.g. `login.response.json`. */
  file: string;
  kind: "request" | "response" | "error";
  operationId?: OperationId;
  errorCode?: ErrorCode;
  /** `undefined` for the main example of an operation. */
  variant?: string;
  /** The schema the fixture must satisfy. */
  schema: z.ZodType;
  value: JsonValue;
};

const OPERATION_FILE = /^([A-Za-z]+)\.(request|response)(?:\.([a-z0-9-]+))?\.json$/;
const ERROR_FILE = /^error\.([A-Z_]+)\.json$/;

function isOperationId(value: string): value is OperationId {
  return Object.hasOwn(ENDPOINTS, value);
}

/** Works out which schema a fixture file belongs to. Throws for names that fit no rule. */
export function describeFixture(file: string, value: JsonValue): Fixture {
  const error = ERROR_FILE.exec(file);
  if (error) {
    const code = error[1] ?? "";
    if (!isErrorCode(code)) throw new Error(`${file}: unknown error code ${code}`);
    return { file, kind: "error", errorCode: code, schema: ErrorResponse, value };
  }
  const match = OPERATION_FILE.exec(file);
  const operationId = match?.[1] ?? "";
  if (!match || !isOperationId(operationId)) {
    throw new Error(
      `${file}: not <operationId>.(request|response)[.variant].json or error.<CODE>.json`,
    );
  }
  const endpoint = ENDPOINTS[operationId];
  const kind = match[2] === "request" ? "request" : "response";
  const schema =
    kind === "request" ? ("body" in endpoint ? endpoint.body : undefined) : endpoint.response;
  if (!schema) throw new Error(`${file}: ${operationId} has no request body`);
  return { file, kind, operationId, variant: match[3], schema, value };
}

/** Every fixture file, sorted by name. */
export function loadFixtures(dir: string = FIXTURES_DIR): Fixture[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => describeFixture(file, JSON.parse(readFileSync(join(dir, file), "utf8"))));
}

/** The main fixtures as OpenAPI examples. */
export function fixtureExamples(fixtures: readonly Fixture[]): BuildOpenApiOptions {
  const examples: NonNullable<BuildOpenApiOptions["examples"]> = {};
  const errorExamples: NonNullable<BuildOpenApiOptions["errorExamples"]> = {};
  for (const fixture of fixtures) {
    if (fixture.kind === "error" && fixture.errorCode) {
      errorExamples[fixture.errorCode] = fixture.value;
    } else if (fixture.operationId && fixture.variant === undefined) {
      const entry = examples[fixture.operationId] ?? {};
      if (fixture.kind === "request") entry.request = fixture.value;
      else entry.response = fixture.value;
      examples[fixture.operationId] = entry;
    }
  }
  return { examples, errorExamples };
}
