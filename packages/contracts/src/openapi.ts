/**
 * Renders {@link ENDPOINTS} as an OpenAPI 3.1 document with `zod-openapi` (PLAN §4, E-05).
 * `scripts/openapi-build.ts` writes it to `openapi.json`; Android generates its DTOs from that file.
 *
 * Normalisation after rendering:
 * - `additionalProperties: false` is removed everywhere. Zod adds it to response objects, but the
 *   contract allows the server to add response fields within v1 (README), and the server ignores
 *   unknown request fields, so neither direction is closed.
 * - No component may be rendered twice (`…Output`): request and response schemas are separate
 *   objects by design, so a duplicate means a schema is shared across directions by mistake.
 */

import {
  createDocument,
  type ZodOpenApiOperationObject,
  type ZodOpenApiPathsObject,
  type ZodOpenApiResponsesObject,
} from "zod-openapi";
import {
  APP_VERSION_HEADER,
  AppVersionHeaders,
  CONTRACT_VERSION,
  ENDPOINT_LIST,
  type Endpoint,
  errorCodesOf,
  MOBILE_API_BASE_PATH,
  type OperationId,
  TAGS,
} from "./endpoints";
import { ERROR_CODE_INFO, type ErrorCode, ErrorResponse } from "./errors";

/** Example bodies attached to an operation (taken from `fixtures/`). */
export type OperationExamples = { request?: unknown; response?: unknown };

export type BuildOpenApiOptions = {
  /** Examples per operation, usually the fixtures. */
  examples?: Partial<Record<OperationId, OperationExamples>>;
  /** One example error body per error code, usually the error fixtures. */
  errorExamples?: Partial<Record<ErrorCode, unknown>>;
};

const STATUS_TEXT: Record<number, string> = {
  400: "Bad request",
  401: "Not signed in",
  403: "Not allowed",
  404: "Not found",
  409: "Conflict",
  426: "App too old",
  429: "Too many requests",
  500: "Server error",
};

/** A JSON value as `JSON.parse` returns it. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function errorResponses(endpoint: Endpoint, examples: BuildOpenApiOptions["errorExamples"]) {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of errorCodesOf(endpoint)) {
    const status = ERROR_CODE_INFO[code].status;
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  const responses: ZodOpenApiResponsesObject = {};
  for (const status of [...byStatus.keys()].sort((a, b) => a - b)) {
    const codes = byStatus.get(status) ?? [];
    // The example of the first code in the group that has one.
    const example = codes.map((code) => examples?.[code]).find((value) => value !== undefined);
    responses[`${status}` as `${4 | 5}${string}`] = {
      description: `${STATUS_TEXT[status] ?? "Error"}. error.code is one of: ${codes.join(", ")}.${
        status === 429
          ? " The Retry-After header carries the same wait as retry_after_seconds."
          : ""
      }`,
      content: {
        "application/json": {
          schema: ErrorResponse,
          ...(example === undefined ? {} : { example }),
        },
      },
    };
  }
  return responses;
}

function operation(endpoint: Endpoint, options: BuildOpenApiOptions): ZodOpenApiOperationObject {
  const examples = options.examples?.[endpoint.operationId as OperationId];
  return {
    operationId: endpoint.operationId,
    tags: [endpoint.tag],
    summary: endpoint.summary,
    description: endpoint.description,
    security: endpoint.auth === "bearer" ? [{ bearerAuth: [] }] : [],
    requestParams: {
      header: AppVersionHeaders,
      ...(endpoint.params ? { path: endpoint.params } : {}),
      ...(endpoint.query ? { query: endpoint.query } : {}),
    },
    ...(endpoint.body
      ? {
          requestBody: {
            required: true,
            description: "JSON body.",
            content: {
              "application/json": {
                schema: endpoint.body,
                ...(examples?.request === undefined ? {} : { example: examples.request }),
              },
            },
          },
        }
      : {}),
    responses: {
      "200": {
        description: "Success.",
        content: {
          "application/json": {
            schema: endpoint.response,
            ...(examples?.response === undefined ? {} : { example: examples.response }),
          },
        },
      },
      ...errorResponses(endpoint, options.errorExamples),
    },
  };
}

/** Removes `additionalProperties: false` (see the module comment). Mutates and returns `value`. */
function openObjects(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const item of value) openObjects(item);
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.additionalProperties === false) delete record.additionalProperties;
    for (const child of Object.values(record)) openObjects(child);
  }
  return value;
}

/** The mobile API as an OpenAPI 3.1 document (a plain JSON value). */
export function buildOpenApiDocument(options: BuildOpenApiOptions = {}): {
  [key: string]: JsonValue;
} {
  const paths: ZodOpenApiPathsObject = {};
  for (const endpoint of ENDPOINT_LIST) {
    paths[endpoint.path] = {
      ...paths[endpoint.path],
      [endpoint.method]: operation(endpoint, options),
    };
  }

  const document = createDocument({
    openapi: "3.1.0",
    info: {
      title: "Cable Billing mobile API",
      version: CONTRACT_VERSION,
      description: [
        "The contract between the lineman Android app and the server (PLAN §10). Generated from the Zod schemas in packages/contracts; do not edit openapi.json by hand.",
        "",
        "- JSON field names are snake_case. Money is integer paise (*_paise). Instants are ISO-8601 UTC with 'Z'. Business dates and periods are YYYY-MM-DD in India time. Ids are UUIDs.",
        "- Every response, success or error, carries server_time. Errors use the ErrorResponse body with a stable error.code.",
        `- Every request carries the '${APP_VERSION_HEADER}' header (Android versionCode). Authenticated endpoints need 'Authorization: Bearer <access_token>'.`,
        "- v1 changes are additive only: clients must ignore unknown response fields and unknown feature flags, and map unknown error codes by HTTP status. See packages/contracts/README.md.",
      ].join("\n"),
    },
    servers: [
      {
        url: MOBILE_API_BASE_PATH,
        description: "Relative to the web app's origin (dev, staging and production hosts differ).",
      },
    ],
    tags: Object.entries(TAGS).map(([name, description]) => ({ name, description })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "The access_token from /auth/login or /auth/refresh. On UNAUTHENTICATED, refresh once and retry.",
        },
      },
    },
  });

  const schemas = Object.keys(document.components?.schemas ?? {});
  const duplicated = schemas.filter((name) => name.endsWith("Output"));
  if (duplicated.length > 0) {
    throw new Error(
      `Schemas rendered twice (shared between request and response?): ${duplicated.join(", ")}`,
    );
  }

  return openObjects(JSON.parse(JSON.stringify(document))) as { [key: string]: JsonValue };
}

/** The committed text of `openapi.json`: two-space JSON with a final newline. */
export function openApiJson(document: { [key: string]: JsonValue }): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
