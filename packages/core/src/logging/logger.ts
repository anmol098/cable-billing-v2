/**
 * Structured JSON logger (PLAN §17, E-08): one JSON object per line, with `request_id` and
 * `operator_id` on every line written inside a service, and **no PII** (see ./pii.ts).
 *
 * ```ts
 * const log = createLogger().child({ request_id, operator_id });
 * log.info("billing.run_started", { period: "2026-10-01", customer_count: 128 });
 * ```
 *
 * - `event` is a dotted snake_case code (`service.completed`), not a sentence.
 * - Fields are ids, codes, counts, amounts, durations. Never names, phones, emails, logins,
 *   addresses, tokens, IPs, user agents, UPI references or notes.
 * - **Strict mode** (the default under Vitest / NODE_ENV=test) throws `PiiInLogError` when a field
 *   looks like PII, so any test that logs PII fails. Outside tests the offending fields are replaced
 *   by "[redacted]" and listed (by path, never by value) in `pii_redacted`, so logging never
 *   crashes a request.
 */
import { sqlStateOf } from "@cb/db";
import { findPii, type PiiFinding, scrubText } from "./pii";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Readonly<Record<string, unknown>>;

/** What a sink receives. `time` is ISO-8601 UTC. */
export interface LogRecord {
  readonly time: string;
  readonly level: LogLevel;
  readonly event: string;
  readonly [field: string]: unknown;
}

export type LogSink = (record: LogRecord) => void;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every record (e.g. request_id, operator_id). */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  /** Where records go. Default: {@link jsonLineSink} (stdout, stderr for warn/error). */
  readonly sink?: LogSink;
  /** Fields added to every record. */
  readonly fields?: LogFields;
  /** Throw on PII instead of redacting. Default: true under Vitest or NODE_ENV=test. */
  readonly strict?: boolean;
  /** Records below this level are dropped. Default `info` (`debug` when LOG_LEVEL=debug). */
  readonly level?: LogLevel;
}

/** Thrown in strict mode when a record would contain PII. Lists paths, never values. */
export class PiiInLogError extends Error {
  readonly findings: readonly PiiFinding[];
  constructor(event: string, findings: readonly PiiFinding[]) {
    super(
      `Log event "${event}" would contain personal data or a secret: ${findings
        .map((f) => `${f.path} (${f.reason})`)
        .join(", ")}`,
    );
    this.name = "PiiInLogError";
    this.findings = findings;
  }
}

const EVENT_FORMAT = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const RESERVED = new Set(["time", "level", "event"]);

function envFlag(name: string): string | undefined {
  return typeof process === "undefined" ? undefined : process.env[name];
}

/** True when tests are running (Vitest sets VITEST=true). */
export function strictLoggingByDefault(): boolean {
  return envFlag("VITEST") === "true" || envFlag("NODE_ENV") === "test";
}

function defaultLevel(): LogLevel {
  const configured = envFlag("LOG_LEVEL");
  return (LOG_LEVELS as readonly string[]).includes(configured ?? "")
    ? (configured as LogLevel)
    : "info";
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** Writes one JSON line per record: debug/info to stdout, warn/error to stderr. */
export const jsonLineSink: LogSink = (record) => {
  const line = `${JSON.stringify(record, jsonReplacer)}\n`;
  if (record.level === "warn" || record.level === "error") process.stderr.write(line);
  else process.stdout.write(line);
};

/**
 * Safe log fields for an error: its type, SQLSTATE/code and constraint, and a PII-scrubbed message
 * for non-database errors (Postgres messages and details can quote row values, so they are
 * dropped).
 */
export function errorLogFields(error: unknown): Record<string, string> {
  const fields: Record<string, string> = {};
  if (error instanceof Error) fields.error_type = error.name;
  else fields.error_type = typeof error;
  const state = sqlStateOf(error);
  if (state) {
    fields.sqlstate = state;
    const constraint = (error as { constraint?: unknown } | null)?.constraint;
    if (typeof constraint === "string") fields.constraint_name = constraint;
  } else if (error instanceof Error) {
    fields.error_message = scrubText(error.message).slice(0, 300);
  }
  return fields;
}

/** Creates a logger. One per process is enough; use `child()` per request. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? jsonLineSink;
  const strict = options.strict ?? strictLoggingByDefault();
  const minLevel = LOG_LEVELS.indexOf(options.level ?? defaultLevel());

  const make = (base: LogFields): Logger => {
    const write = (level: LogLevel, event: string, fields: LogFields = {}) => {
      if (LOG_LEVELS.indexOf(level) < minLevel) return;
      let name = event;
      if (!EVENT_FORMAT.test(event)) {
        if (strict) throw new TypeError(`Log event must be dotted snake_case, got "${event}"`);
        name = "invalid_event_name";
      }
      const merged: Record<string, unknown> = {};
      for (const [key, value] of Object.entries({ ...base, ...fields })) {
        if (!RESERVED.has(key) && value !== undefined) merged[key] = value;
      }
      const findings = findPii(merged);
      if (findings.length > 0) {
        if (strict) throw new PiiInLogError(name, findings);
        const topLevel = new Set(findings.map((f) => f.path.split(/[.[]/)[0] ?? f.path));
        for (const key of topLevel) merged[key] = "[redacted]";
        merged.pii_redacted = findings.map((f) => f.path);
      }
      sink({ time: new Date().toISOString(), level, event: name, ...merged });
    };
    return {
      debug: (event, fields) => write("debug", event, fields),
      info: (event, fields) => write("info", event, fields),
      warn: (event, fields) => write("warn", event, fields),
      error: (event, fields) => write("error", event, fields),
      child: (fields) => {
        if (strict) {
          const findings = findPii(fields);
          if (findings.length > 0) throw new PiiInLogError("child", findings);
        }
        return make({ ...base, ...fields });
      },
    };
  };
  return make(options.fields ?? {});
}

/** A logger that drops everything (for scripts that opt out explicitly). */
export const silentLogger: Logger = createLogger({ sink: () => {}, strict: false });
