/**
 * What every scenario gets: the target, the load shape, the seed's users, the recorder, and signed-in
 * sessions shared within the run (one sign-in per user per run, whatever scenarios need them).
 */
import {
  type AuthDeps,
  type MobileSession,
  type SessionCache,
  SignInBudgetError,
  type SignInGovernor,
  signInMobile,
  signInWeb,
} from "./auth";
import type { Session } from "./http";
import type { OperatorPersonas } from "./personas";
import type { Profile } from "./profiles";
import type { Recorder } from "./stats";

export interface RunOptions {
  readonly baseUrl: string;
  readonly profile: Profile;
  readonly personas: readonly OperatorPersonas[];
  readonly password: string;
  readonly cronSecret: string | undefined;
  readonly appVersionCode: number;
  /** Parallel job-worker invocations during the billing run (Vercel overlaps about 2). */
  readonly billingWorkers: number;
  /** How often to poll for the billing run, ms (tests use a small value). */
  readonly billingPollMs?: number;
  readonly log: (line: string) => void;
}

export interface RunContext extends RunOptions {
  readonly recorder: Recorder;
  readonly auth: AuthDeps;
  readonly startedMs: number;
  web(login: string): Promise<Session>;
  mobile(login: string): Promise<MobileSession>;
  /** Shared roster per operator number (filled by the sync scenario, reused by payments). */
  readonly rosters: Map<number, RosterEntry[]>;
  /** Each phone's roster cursor (login → next_cursor), carried from the sync to the payments. */
  readonly cursors: Map<string, string>;
}

/** What the scenarios keep from a roster row. */
export interface RosterEntry {
  readonly id: string;
  readonly active: boolean;
  readonly balancePaise: number;
}

export function createContext(
  options: RunOptions,
  recorder: Recorder,
  governor: SignInGovernor,
  cache: SessionCache,
): RunContext {
  const auth: AuthDeps = {
    baseUrl: options.baseUrl,
    password: options.password,
    recorder,
    governor,
    cache,
    appVersionCode: options.appVersionCode,
  };
  const web = new Map<string, Promise<Session>>();
  const mobile = new Map<string, Promise<MobileSession>>();
  return {
    ...options,
    recorder,
    auth,
    startedMs: Date.now(),
    rosters: new Map(),
    cursors: new Map(),
    web(login) {
      let session = web.get(login);
      if (!session) {
        session = signInWeb(auth, login);
        web.set(login, session);
      }
      return session;
    },
    mobile(login) {
      let session = mobile.get(login);
      if (!session) {
        session = signInMobile(auth, login);
        mobile.set(login, session);
      }
      return session;
    },
  };
}

/** Runs `work` over `items` with at most `concurrency` at once; collects errors instead of failing. */
export async function pool<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  let next = 0;
  const lanes = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        try {
          await work(items[index] as T, index);
        } catch (error) {
          // A sign-in budget refusal must stop the run, not be counted as one failed user.
          if (error instanceof SignInBudgetError) throw error;
          errors.push(error);
        }
      }
    },
  );
  await Promise.all(lanes);
  return errors;
}

/**
 * Signs every user in first (four at a time: sign-in hashes passwords, and a sign-in storm is not
 * what is being measured), so the burst afterwards starts with everyone ready at once.
 */
export async function signInAll<T>(
  logins: readonly string[],
  signIn: (login: string) => Promise<T>,
  log: (line: string) => void,
  label: string,
): Promise<Array<{ login: string; session: T }>> {
  const ready: Array<{ login: string; session: T }> = [];
  const errors = await pool(logins, 4, async (login) => {
    ready.push({ login, session: await signIn(login) });
  });
  for (const error of errors) log(`  ${label}: ${errorText(error)}`);
  // A user who can't sign in would make the burst smaller than planned and the result look better.
  if (errors.length > 0) {
    throw new Error(
      `${errors.length} of ${logins.length} ${label}s could not sign in (see the log)`,
    );
  }
  return ready.sort((a, b) => a.login.localeCompare(b.login));
}

/**
 * Runs every user's script at the same moment. A user whose script throws (not an HTTP error,
 * which is a recorded sample, but a broken step) is logged, and the scenario then stops with an
 * error so the run cannot pass with silently missing users.
 */
export async function everyone<T extends { login: string }>(
  ctx: Pick<RunContext, "log">,
  users: readonly T[],
  label: string,
  script: (user: T) => Promise<void>,
): Promise<void> {
  const failed: string[] = [];
  await Promise.all(
    users.map(async (user) => {
      try {
        await script(user);
      } catch (error) {
        if (error instanceof SignInBudgetError) throw error;
        failed.push(user.login);
        ctx.log(`  ${label} ${user.login}: ${errorText(error)}`);
      }
    }),
  );
  if (failed.length > 0) {
    throw new Error(
      `${failed.length} of ${users.length} ${label}s stopped with an error (see the log)`,
    );
  }
}

/** A deterministic-enough pick (Math.random is fine: load, not data). */
export function pick<T>(items: readonly T[]): T | undefined {
  return items[Math.floor(Math.random() * items.length)];
}

export function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
