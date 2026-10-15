/**
 * Signing virtual users in without tripping (or weakening) the production rate limits.
 *
 * The limits (T-026 / T-028): sign-in **100 per IP per 15 min** and **10 per account per 15 min**
 * (web and phone share them); mobile refresh 600 per IP and 30 per install per 15 min. A load run
 * comes from one IP, so:
 *
 * - the {@link SignInGovernor} refuses to plan more than `maxSignIns` real sign-ins per run
 *   (default 90, never more than 100) and more than one per account;
 * - the {@link SessionCache} keeps each user's web session cookie (30 days) and phone refresh token
 *   (180 days, rotated on use) in `tools/load/.cache/` (git-ignored), so the next run reuses them
 *   instead of signing in again. A large run is warmed up over several 15-minute windows with
 *   `load warm` (see docs/testing/performance.md).
 *
 * There is no test bypass, and the tool never spoofs `X-Forwarded-For`: on Vercel the edge
 * overwrites it anyway, and a load test that only passes with a weakened limit proves nothing.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  APP_VERSION_HEADER,
  type LoginResponse,
  MOBILE_API_BASE_PATH,
  type RefreshResponse,
} from "@cb/contracts";
import { jsonOf, reasonOf, Session } from "./http";
import { installIdFor } from "./ids";
import { formSubmission } from "./next";
import type { Recorder } from "./stats";

/** The server's per-IP sign-in limit (`AUTH_RATE_LIMITS.signInPerIp`). */
export const SIGN_IN_PER_IP_LIMIT = 100;
export const DEFAULT_MAX_SIGN_INS = 90;
/** The server's per-IP refresh limit (`MOBILE_AUTH_RATE_LIMITS.refreshPerIp`), with a margin. */
export const MAX_REFRESHES = 550;

export class SignInBudgetError extends Error {
  override readonly name = "SignInBudgetError";
}

export class SignInGovernor {
  #signIns = 0;
  #refreshes = 0;
  readonly #accounts = new Set<string>();

  constructor(readonly maxSignIns = DEFAULT_MAX_SIGN_INS) {
    if (!Number.isInteger(maxSignIns) || maxSignIns < 0 || maxSignIns > SIGN_IN_PER_IP_LIMIT) {
      throw new SignInBudgetError(
        `max sign-ins must be 0…${SIGN_IN_PER_IP_LIMIT} (the server allows ${SIGN_IN_PER_IP_LIMIT} per IP per 15 minutes)`,
      );
    }
  }

  get signIns(): number {
    return this.#signIns;
  }

  get refreshes(): number {
    return this.#refreshes;
  }

  /** Call before every real sign-in. Throws when the run would exceed its budget. */
  takeSignIn(login: string): void {
    if (this.#accounts.has(login)) {
      throw new SignInBudgetError(`${login} was already signed in once in this run`);
    }
    if (this.#signIns >= this.maxSignIns) {
      throw new SignInBudgetError(
        `this run already used its ${this.maxSignIns} sign-ins (server limit: ${SIGN_IN_PER_IP_LIMIT} per IP per 15 min). Warm the session cache with \`load warm\` over several 15-minute windows, or use fewer users.`,
      );
    }
    this.#accounts.add(login);
    this.#signIns += 1;
  }

  takeRefresh(): void {
    if (this.#refreshes >= MAX_REFRESHES) {
      throw new SignInBudgetError(`this run already used its ${MAX_REFRESHES} token refreshes`);
    }
    this.#refreshes += 1;
  }
}

export interface WebCacheEntry {
  readonly kind: "web";
  readonly cookies: Record<string, string>;
  readonly savedAt: string;
}

export interface MobileCacheEntry {
  readonly kind: "mobile";
  readonly installId: string;
  readonly refreshToken: string;
  readonly refreshExpiresAt: string;
  readonly accessToken: string;
  readonly accessExpiresAt: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly deviceCode: string;
  readonly savedAt: string;
}

type CacheEntry = WebCacheEntry | MobileCacheEntry;

/** Sign-ins kept between runs, per (target origin, login). File mode 0600. */
export class SessionCache {
  readonly #entries: Map<string, CacheEntry>;

  constructor(readonly path: string | null) {
    this.#entries = new Map();
    if (path && existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as {
          version?: number;
          entries?: Record<string, CacheEntry>;
        };
        if (parsed.version === 1) {
          for (const [key, entry] of Object.entries(parsed.entries ?? {})) {
            this.#entries.set(key, entry);
          }
        }
      } catch {
        // A damaged cache is ignored; users sign in again.
      }
    }
  }

  static key(baseUrl: string, login: string): string {
    return `${new URL(baseUrl).origin}|${login}`;
  }

  get(baseUrl: string, login: string): CacheEntry | undefined {
    return this.#entries.get(SessionCache.key(baseUrl, login));
  }

  set(baseUrl: string, login: string, entry: CacheEntry): void {
    this.#entries.set(SessionCache.key(baseUrl, login), entry);
  }

  delete(baseUrl: string, login: string): void {
    this.#entries.delete(SessionCache.key(baseUrl, login));
  }

  get size(): number {
    return this.#entries.size;
  }

  save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(
      temp,
      `${JSON.stringify({ version: 1, entries: Object.fromEntries(this.#entries) }, null, 2)}\n`,
      { mode: 0o600 },
    );
    renameSync(temp, this.path);
    chmodSync(this.path, 0o600);
  }
}

export interface AuthDeps {
  readonly baseUrl: string;
  readonly password: string;
  readonly recorder: Recorder;
  readonly governor: SignInGovernor;
  readonly cache: SessionCache;
  /** The app's versionCode sent in `x-app-version-code` (must be ≥ the target's minimum). */
  readonly appVersionCode: number;
}

export class SignInError extends Error {
  override readonly name = "SignInError";
}

/**
 * A signed-in web user (Owner or Staff). Reuses a cached cookie when it still opens `/home`;
 * otherwise posts the login form (one sign-in from the budget).
 */
export async function signInWeb(deps: AuthDeps, login: string): Promise<Session> {
  const cached = deps.cache.get(deps.baseUrl, login);
  if (cached?.kind === "web") {
    const session = new Session(deps.baseUrl, deps.recorder, { cookies: cached.cookies });
    // A stale cookie redirects to /login: expected, not an error.
    const check = await session.request("/home", {
      metric: "web.auth.cached_session",
      okStatuses: [200, 302, 303, 307],
    });
    if (check.status === 200) return session;
    deps.cache.delete(deps.baseUrl, login);
  }
  deps.governor.takeSignIn(login);
  const session = new Session(deps.baseUrl, deps.recorder);
  const page = await session.request("/login", { metric: "web.auth.login_page" });
  if (page.status !== 200) throw new SignInError(`GET /login answered ${reasonOf(page)}`);
  const body = formSubmission(page.text, { login, password: deps.password });
  const answer = await session.request("/login", {
    method: "POST",
    body,
    headers: { origin: new URL(deps.baseUrl).origin },
    okStatuses: [303],
    metric: "web.auth.sign_in",
  });
  if (answer.status !== 303 || session.cookies.size === 0) {
    throw new SignInError(
      `sign-in of ${login} answered ${reasonOf(answer)} (expected 303 + a session cookie; wrong password, rate limit or a changed login form)`,
    );
  }
  deps.cache.set(deps.baseUrl, login, {
    kind: "web",
    cookies: session.cookies.toJSON(),
    savedAt: new Date().toISOString(),
  });
  return session;
}

/** A signed-in phone: bearer token, device code, and a way to stay signed in past 15 minutes. */
export class MobileSession {
  constructor(
    readonly login: string,
    readonly http: Session,
    readonly deps: AuthDeps,
    public entry: MobileCacheEntry,
  ) {
    http.bearer = entry.accessToken;
  }

  get userId(): string {
    return this.entry.userId;
  }

  get deviceId(): string {
    return this.entry.deviceId;
  }

  get deviceCode(): string {
    return this.entry.deviceCode;
  }

  /** Refreshes when the access token has less than a minute left (as the app does). */
  async ensureFresh(now = Date.now()): Promise<void> {
    if (Date.parse(this.entry.accessExpiresAt) - now > 60_000) return;
    const refreshed = await refreshMobile(this.deps, this.login, this.entry);
    if (!refreshed) throw new SignInError(`refresh of ${this.login} failed`);
    this.entry = refreshed;
    this.http.bearer = refreshed.accessToken;
  }
}

function mobileHeaders(deps: AuthDeps): Record<string, string> {
  return { [APP_VERSION_HEADER]: String(deps.appVersionCode), "content-type": "application/json" };
}

async function refreshMobile(
  deps: AuthDeps,
  login: string,
  entry: MobileCacheEntry,
): Promise<MobileCacheEntry | undefined> {
  deps.governor.takeRefresh();
  const http = new Session(deps.baseUrl, deps.recorder, { defaultHeaders: mobileHeaders(deps) });
  const answer = await http.request(`${MOBILE_API_BASE_PATH}/auth/refresh`, {
    method: "POST",
    body: JSON.stringify({ refresh_token: entry.refreshToken, install_id: entry.installId }),
    metric: "mobile.auth.refresh",
  });
  const body = answer.ok ? jsonOf<RefreshResponse>(answer) : undefined;
  if (!body) {
    deps.cache.delete(deps.baseUrl, login);
    return undefined;
  }
  const next: MobileCacheEntry = {
    ...entry,
    refreshToken: body.tokens.refresh_token,
    refreshExpiresAt: body.tokens.refresh_token_expires_at,
    accessToken: body.tokens.access_token,
    accessExpiresAt: body.tokens.access_token_expires_at,
    savedAt: new Date().toISOString(),
  };
  // Saved at once: the old refresh token is spent, and losing the new one signs the phone out.
  deps.cache.set(deps.baseUrl, login, next);
  deps.cache.save();
  return next;
}

/** A signed-in lineman phone: the cached token (refreshed if needed), else `POST /auth/login`. */
export async function signInMobile(deps: AuthDeps, login: string): Promise<MobileSession> {
  const http = new Session(deps.baseUrl, deps.recorder, { defaultHeaders: mobileHeaders(deps) });
  const cached = deps.cache.get(deps.baseUrl, login);
  if (cached?.kind === "mobile" && Date.parse(cached.refreshExpiresAt) > Date.now()) {
    const session = new MobileSession(login, http, deps, cached);
    try {
      await session.ensureFresh();
      return session;
    } catch {
      // Fall through to a real sign-in.
    }
  }
  deps.governor.takeSignIn(login);
  const installId = installIdFor(deps.baseUrl, login);
  const answer = await http.request(`${MOBILE_API_BASE_PATH}/auth/login`, {
    method: "POST",
    body: JSON.stringify({
      login,
      password: deps.password,
      device: {
        install_id: installId,
        model: "cb-load virtual phone",
        os: "load-test",
        app_version: "load",
        app_version_code: deps.appVersionCode,
      },
    }),
    metric: "mobile.auth.login",
  });
  const body = answer.ok ? jsonOf<LoginResponse>(answer) : undefined;
  if (!body) throw new SignInError(`phone sign-in of ${login} answered ${reasonOf(answer)}`);
  const entry: MobileCacheEntry = {
    kind: "mobile",
    installId,
    refreshToken: body.tokens.refresh_token,
    refreshExpiresAt: body.tokens.refresh_token_expires_at,
    accessToken: body.tokens.access_token,
    accessExpiresAt: body.tokens.access_token_expires_at,
    userId: body.user.id,
    deviceId: body.device.id,
    deviceCode: body.device.device_code,
    savedAt: new Date().toISOString(),
  };
  deps.cache.set(deps.baseUrl, login, entry);
  return new MobileSession(login, http, deps, entry);
}
