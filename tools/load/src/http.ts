/**
 * A timed HTTP client on Node's built-in `fetch` (undici, keep-alive). One `Session` per virtual
 * user: it holds that user's cookies (web) or bearer token (mobile), so users never share a sign-in.
 */
import type { Recorder } from "./stats";

export interface TimedResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly ms: number;
  /** Time until the status line and headers arrived. */
  readonly ttfbMs: number;
  readonly headers: Headers;
  readonly text: string;
  /** Wire bytes when the server sent `content-length` (gzip size for gzipped bodies), else decoded. */
  readonly bytes: number;
  /** Set when the request failed before a response (timeout, connection refused). */
  readonly networkError?: string;
}

export interface RequestOptions {
  readonly method?: "GET" | "POST" | "PATCH";
  readonly headers?: Record<string, string>;
  readonly body?: string | FormData;
  readonly timeoutMs?: number;
  /** Statuses that count as success for the metric (default: 200–299). */
  readonly okStatuses?: readonly number[];
  /** Metric to record under; nothing is recorded when omitted. */
  readonly metric?: string;
}

export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Headers sent on every request of the process, e.g. Vercel's `x-vercel-protection-bypass` for a
 * protected preview deployment (`LOAD_VERCEL_BYPASS_SECRET`). Set once by the CLI.
 */
let extraHeaders: Readonly<Record<string, string>> = {};

export function setExtraHeaders(headers: Readonly<Record<string, string>>): void {
  extraHeaders = { ...headers };
}

/** Minimal cookie jar: name → value, from `Set-Cookie` (path/expiry ignored: one origin). */
export class CookieJar {
  readonly #cookies = new Map<string, string>();

  constructor(initial?: Readonly<Record<string, string>>) {
    for (const [name, value] of Object.entries(initial ?? {})) this.#cookies.set(name, value);
  }

  store(headers: Headers): void {
    for (const line of headers.getSetCookie()) {
      const pair = line.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (/max-age=0\b/i.test(line) || value === "") this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }

  header(): string | undefined {
    if (this.#cookies.size === 0) return undefined;
    return [...this.#cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries(this.#cookies);
  }

  get size(): number {
    return this.#cookies.size;
  }
}

export class Session {
  readonly cookies: CookieJar;
  readonly defaultHeaders: Record<string, string>;
  bearer: string | undefined;

  constructor(
    readonly baseUrl: string,
    readonly recorder: Recorder,
    options: {
      cookies?: Readonly<Record<string, string>>;
      defaultHeaders?: Record<string, string>;
    } = {},
  ) {
    this.cookies = new CookieJar(options.cookies);
    this.defaultHeaders = options.defaultHeaders ?? {};
  }

  url(path: string): string {
    return new URL(path, this.baseUrl).toString();
  }

  /** Sends one request, reads the whole body, records it under `options.metric`. Never throws. */
  async request(path: string, options: RequestOptions = {}): Promise<TimedResponse> {
    const headers: Record<string, string> = {
      ...extraHeaders,
      ...this.defaultHeaders,
      ...options.headers,
    };
    const cookie = this.cookies.header();
    if (cookie) headers.cookie = cookie;
    if (this.bearer) headers.authorization = `Bearer ${this.bearer}`;
    const started = performance.now();
    let response: TimedResponse;
    try {
      const res = await fetch(this.url(path), {
        method: options.method ?? "GET",
        headers,
        body: options.body,
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      const ttfbMs = performance.now() - started;
      const text = await res.text();
      const ms = performance.now() - started;
      this.cookies.store(res.headers);
      const length = Number(res.headers.get("content-length"));
      response = {
        status: res.status,
        ok: options.okStatuses ? options.okStatuses.includes(res.status) : res.ok,
        ms,
        ttfbMs,
        headers: res.headers,
        text,
        bytes: Number.isFinite(length) && length > 0 ? length : Buffer.byteLength(text),
      };
    } catch (error) {
      const ms = performance.now() - started;
      const name = error instanceof Error ? error.name : "Error";
      response = {
        status: 0,
        ok: false,
        ms,
        ttfbMs: ms,
        headers: new Headers(),
        text: "",
        bytes: 0,
        networkError: name === "TimeoutError" ? "timeout" : name,
      };
    }
    if (options.metric) {
      this.recorder.record(
        options.metric,
        { ms: response.ms, ok: response.ok, bytes: response.bytes },
        response.ok ? undefined : reasonOf(response),
      );
    }
    return response;
  }
}

/** A short reason for an error sample: the network error, the contract error code, or the status. */
export function reasonOf(response: TimedResponse): string {
  if (response.networkError) return response.networkError;
  const code = errorCodeOf(response.text);
  return code ? `${response.status} ${code}` : String(response.status);
}

/** `error.code` of a mobile API error body (`{ error: { code } }`), else undefined. */
export function errorCodeOf(text: string): string | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    const body = JSON.parse(text) as { error?: { code?: unknown } | string };
    if (typeof body.error === "string") return body.error;
    return typeof body.error?.code === "string" ? body.error.code : undefined;
  } catch {
    return undefined;
  }
}

/** Parses a JSON body, or undefined (a load test must not crash on one bad answer). */
export function jsonOf<T>(response: TimedResponse): T | undefined {
  try {
    return JSON.parse(response.text) as T;
  } catch {
    return undefined;
  }
}
