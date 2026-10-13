/**
 * Tests over the generated OpenAPI document: committed file is current, every field is documented,
 * and the wire conventions hold everywhere (integer paise, UTC times, YYYY-MM-DD dates, UUID ids,
 * server_time on every response, honest receipt states).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENDPOINT_LIST, errorCodesOf } from "./endpoints";
import { ERROR_CODE_INFO } from "./errors";
import { FIXTURES_DIR, fixtureExamples, loadFixtures } from "./fixtures";
import { buildOpenApiDocument, type JsonValue, openApiJson } from "./openapi";

type Json = { [key: string]: JsonValue };

const committedPath = join(FIXTURES_DIR, "..", "openapi.json");
const document = buildOpenApiDocument(fixtureExamples(loadFixtures()));
const schemas = (document.components as Json).schemas as Json;
const paths = document.paths as Json;

function isObject(value: JsonValue | undefined): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Calls `visit` for every named property of every object schema in the document. */
function forEachProperty(
  node: JsonValue,
  visit: (name: string, schema: Json, where: string) => void,
  where = "#",
): void {
  if (Array.isArray(node)) {
    node.forEach((child, index) => {
      forEachProperty(child, visit, `${where}/${index}`);
    });
    return;
  }
  if (!isObject(node)) return;
  // Examples are data, not schemas.
  for (const [key, child] of Object.entries(node)) {
    if (key === "example" || key === "examples") continue;
    if (key === "properties" && isObject(child) && node.type === "object") {
      for (const [name, property] of Object.entries(child)) {
        if (isObject(property)) visit(name, property, `${where}/properties/${name}`);
      }
    }
    forEachProperty(child, visit, `${where}/${key}`);
  }
}

/** The schema a property points at (follows one `$ref` and nullable `anyOf`). */
function resolve(schema: Json): Json {
  const ref = schema.$ref;
  if (typeof ref === "string") {
    return (schemas[ref.replace("#/components/schemas/", "")] as Json | undefined) ?? schema;
  }
  if (Array.isArray(schema.anyOf)) {
    const nonNull = schema.anyOf.filter((option) => isObject(option) && option.type !== "null");
    if (nonNull.length === 1 && isObject(nonNull[0])) return resolve(nonNull[0]);
  }
  return schema;
}

function allProperties(): { name: string; schema: Json; where: string }[] {
  const found: { name: string; schema: Json; where: string }[] = [];
  forEachProperty(document, (name, schema, where) => {
    found.push({ name, schema, where });
  });
  return found;
}

describe("openapi.json", () => {
  it("is committed and current (run `pnpm --filter @cb/contracts openapi:build`)", () => {
    expect(readFileSync(committedPath, "utf8")).toBe(openApiJson(document));
  });

  it("is OpenAPI 3.1 with the v1 base path", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(document.servers).toEqual([expect.objectContaining({ url: "/api/mobile/v1" })]);
  });

  it("has one operation per endpoint, each with id, summary, description and tag", () => {
    const operations = Object.values(paths).flatMap((item) =>
      Object.values(item as Json),
    ) as Json[];
    expect(operations.map((op) => op.operationId).sort()).toEqual(
      ENDPOINT_LIST.map((endpoint) => endpoint.operationId).sort(),
    );
    for (const op of operations) {
      expect(op.summary, String(op.operationId)).toBeTruthy();
      expect(op.description, String(op.operationId)).toBeTruthy();
      expect(op.tags, String(op.operationId)).toHaveLength(1);
    }
  });
});

describe("every field is documented", () => {
  const properties = allProperties();

  it("finds the properties (sanity)", () => {
    expect(properties.length).toBeGreaterThan(150);
  });

  it("every property of every schema has a description", () => {
    const undocumented = properties
      .filter(({ schema }) => typeof schema.description !== "string" || schema.description === "")
      .map(({ where }) => where);
    expect(undocumented).toEqual([]);
  });

  it("every component schema has a description", () => {
    const missing = Object.entries(schemas)
      .filter(([, schema]) => typeof (schema as Json).description !== "string")
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it("every parameter, request body and response has a description", () => {
    const missing: string[] = [];
    for (const [path, item] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(item as Json)) {
        const where = `${method.toUpperCase()} ${path}`;
        for (const parameter of ((op as Json).parameters ?? []) as Json[]) {
          if (!parameter.description) missing.push(`${where} parameter ${parameter.name}`);
        }
        const body = (op as Json).requestBody as Json | undefined;
        if (body && !body.description) missing.push(`${where} requestBody`);
        for (const [status, response] of Object.entries((op as Json).responses as Json)) {
          if (!(response as Json).description) missing.push(`${where} ${status}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("the undocumented-field check fails on an undocumented field", () => {
    const sample: Json = {
      type: "object",
      properties: { documented: { type: "string", description: "x" }, bare: { type: "string" } },
    };
    const bare: string[] = [];
    forEachProperty(sample, (name, schema) => {
      if (!schema.description) bare.push(name);
    });
    expect(bare).toEqual(["bare"]);
  });
});

describe("wire conventions", () => {
  const properties = allProperties();

  it("money (*_paise) is always an integer, never a float", () => {
    const money = properties.filter(({ name }) => name.endsWith("_paise"));
    expect(money.length).toBeGreaterThan(20);
    for (const { schema, where } of money) {
      expect(resolve(schema).type, where).toBe("integer");
    }
  });

  it("no schema anywhere uses a floating-point number type", () => {
    expect(JSON.stringify(document)).not.toMatch(/"type":\s*"number"/);
  });

  it("instants (*_at, server_time) are date-time strings in UTC ('Z' only)", () => {
    const instants = properties.filter(
      ({ name }) => name.endsWith("_at") || name === "server_time" || name === "at",
    );
    expect(instants.length).toBeGreaterThan(20);
    for (const { schema, where } of instants) {
      const target = resolve(schema);
      expect(target.format, where).toBe("date-time");
      expect(String(target.pattern), where).toMatch(/\(\?:Z\)\)\$$/);
    }
  });

  it("business dates and periods are YYYY-MM-DD dates", () => {
    const dates = properties.filter(({ name }) =>
      ["business_date", "period", "oldest_period"].includes(name),
    );
    expect(dates.length).toBeGreaterThan(4);
    for (const { schema, where } of dates) {
      expect(resolve(schema).format, where).toBe("date");
    }
  });

  it("ids (id, *_id, *_ids) are UUID strings, except request_id", () => {
    const ids = properties.filter(
      ({ name }) =>
        (name === "id" || name.endsWith("_id") || name.endsWith("_ids")) && name !== "request_id",
    );
    expect(ids.length).toBeGreaterThan(20);
    for (const { name, schema, where } of ids) {
      const target = resolve(schema);
      const item = name.endsWith("_ids") ? resolve(target.items as Json) : target;
      expect(item.format, where).toBe("uuid");
    }
  });

  it("path parameters that are ids or dates have the right format", () => {
    for (const item of Object.values(paths)) {
      for (const op of Object.values(item as Json)) {
        for (const parameter of ((op as Json).parameters ?? []) as Json[]) {
          if (parameter.in !== "path") continue;
          const format = (parameter.schema as Json).format;
          expect(format, String(parameter.name)).toBe(parameter.name === "date" ? "date" : "uuid");
        }
      }
    }
  });

  it("every response body (success and error) carries server_time", () => {
    for (const [path, item] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(item as Json)) {
        for (const [status, response] of Object.entries((op as Json).responses as Json)) {
          const schema = resolve(((response as Json).content as Json)["application/json"] as Json);
          const body = resolve(schema.schema as Json);
          expect(body.required, `${method} ${path} ${status}`).toContain("server_time");
        }
      }
    }
  });

  it("the version header is required on every operation", () => {
    for (const item of Object.values(paths)) {
      for (const op of Object.values(item as Json)) {
        const header = ((op as Json).parameters as Json[]).find(
          (parameter) => parameter.in === "header" && parameter.name === "x-app-version-code",
        );
        expect(header?.required).toBe(true);
      }
    }
  });

  it("documents each endpoint's error codes under the right HTTP status", () => {
    for (const endpoint of ENDPOINT_LIST) {
      const responses = (paths[endpoint.path] as Json)[endpoint.method] as Json;
      for (const code of errorCodesOf(endpoint)) {
        const response = (responses.responses as Json)[String(ERROR_CODE_INFO[code].status)] as
          | Json
          | undefined;
        expect(response?.description, `${endpoint.operationId} ${code}`).toContain(code);
      }
    }
  });

  it("is honest about messages: no enum value claims 'sent' or 'delivered'", () => {
    const enumValues: string[] = [];
    const walk = (node: JsonValue): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (isObject(node)) {
        if (Array.isArray(node.enum)) enumValues.push(...node.enum.map(String));
        Object.values(node).forEach(walk);
      }
    };
    walk(document);
    expect(enumValues).toContain("whatsapp_opened");
    expect(enumValues.filter((value) => /sent|deliver/i.test(value))).toEqual([]);
  });

  it("no object is closed to new fields (additive changes within v1)", () => {
    expect(JSON.stringify(document)).not.toContain('"additionalProperties":false');
  });
});
