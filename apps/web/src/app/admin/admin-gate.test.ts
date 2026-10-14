// @vitest-environment node
/**
 * The admin console's server-side gate (T-086): platform_admin + TOTP on every route.
 *
 * 1. Static: every `layout.tsx` / `page.tsx` under `app/admin` and every exported Server Action
 *    in its `actions.ts` files calls `getAdminContext()` before anything else it does (layouts
 *    don't re-run on client navigation, and Server Actions can be posted directly).
 * 2. `getAdminContext()` itself with T-026's real `requirePlatformAdmin` over a faked session:
 *    nobody → /login, a tenant user → /home, an admin without TOTP → enrolment, an admin whose row
 *    says otherwise (resolveAdminContext) → refused; only a verified admin gets a context.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAdminContext, type WebSession } from "@cb/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAdminContext } from "./_lib/context";

const ADMIN_DIR = fileURLToPath(new URL(".", import.meta.url));

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files(path, out);
    else out.push(path);
  }
  return out;
}

describe("every admin route and action calls getAdminContext() first", () => {
  const all = files(ADMIN_DIR);

  it("covers every page and layout", () => {
    const routes = all.filter((f) => /[/\\](page|layout)\.tsx$/.test(f));
    expect(routes.length).toBeGreaterThanOrEqual(9);
    for (const file of routes) {
      const source = readFileSync(file, "utf8");
      const body = source.slice(source.indexOf("export default async function"));
      expect(body, relative(ADMIN_DIR, file)).toMatch(
        /export default async function \w+\([^)]*(?:\{[^}]*\}[^)]*)?\)[^{]*\{\s*(?:const ctx = )?await getAdminContext\(\);/s,
      );
    }
  });

  it("covers every exported Server Action", () => {
    const actionFiles = all.filter((f) => /[/\\]actions\.ts$/.test(f));
    expect(actionFiles.length).toBeGreaterThanOrEqual(3);
    let count = 0;
    for (const file of actionFiles) {
      const source = readFileSync(file, "utf8");
      expect(source.startsWith('"use server";'), relative(ADMIN_DIR, file)).toBe(true);
      const exported = [
        ...source.matchAll(/export async function (\w+)\([^)]*\)[^{]*\{\s*([^\n]*)/g),
      ];
      expect(exported.length, relative(ADMIN_DIR, file)).toBeGreaterThan(0);
      for (const [, name, firstLine] of exported) {
        count += 1;
        expect(firstLine, `${relative(ADMIN_DIR, file)}: ${name}`).toBe(
          "const ctx = await getAdminContext();",
        );
      }
    }
    expect(count).toBeGreaterThanOrEqual(6);
  });
});

// --- getAdminContext with a faked session ---------------------------------------------------

class Redirect extends Error {
  constructor(readonly path: string) {
    super(`redirect ${path}`);
  }
}

const state: { session: WebSession | null; resolve: unknown } = { session: null, resolve: null };

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Redirect(path);
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-cb-pathname": "/admin/jobs" }),
}));
vi.mock("@/lib/auth/server", () => ({
  getAuthService: () => ({ getSession: async () => state.session }),
  getServerRuntime: () => ({ db: {}, logger: {}, now: () => new Date() }),
}));
vi.mock("@cb/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cb/core")>();
  return { ...actual, resolveAdminContext: vi.fn(async () => state.resolve) };
});

function session(overrides: Partial<WebSession>): WebSession {
  return {
    sessionId: "s1",
    userId: "0199a0b0-0000-7000-8000-0000000000a1",
    role: "platform_admin",
    operatorId: null,
    language: "en",
    twoFactorEnabled: true,
    twoFactorEnrolmentRequired: false,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  };
}

async function gate(): Promise<unknown> {
  try {
    return await getAdminContext();
  } catch (error) {
    if (error instanceof Redirect) return { redirect: error.path };
    throw error;
  }
}

describe("getAdminContext()", () => {
  beforeEach(() => {
    state.session = null;
    state.resolve = null;
  });

  it("no session → sign in (back to the asked page)", async () => {
    expect(await gate()).toEqual({ redirect: "/login?next=%2Fadmin%2Fjobs" });
  });

  it("owner and staff → their home, never the console", async () => {
    for (const role of ["owner", "staff"] as const) {
      state.session = session({ role, operatorId: "0199a0b0-0000-7000-8000-0000000000b1" });
      expect(await gate(), role).toEqual({ redirect: "/home" });
    }
  });

  it("an admin without TOTP → enrolment first", async () => {
    state.session = session({ twoFactorEnabled: false, twoFactorEnrolmentRequired: true });
    expect(await gate()).toEqual({ redirect: "/login/2fa/setup" });
  });

  it("the database has the last word (resolveAdminContext)", async () => {
    state.session = session({});
    state.resolve = {
      ok: false,
      error: { code: "FORBIDDEN", details: { reason: "two_factor_required" } },
    };
    expect(await gate()).toEqual({ redirect: "/login/2fa/setup" });
    state.resolve = {
      ok: false,
      error: { code: "FORBIDDEN", details: { reason: "not_a_platform_admin" } },
    };
    expect(await gate()).toEqual({ redirect: "/home" });
    state.resolve = { ok: false, error: { code: "ACCOUNT_DISABLED" } };
    expect(await gate()).toEqual({ redirect: "/login?next=%2Fadmin%2Fjobs" });
  });

  it("a verified admin gets the context from resolveAdminContext", async () => {
    state.session = session({});
    const ctx = { userId: "0199a0b0-0000-7000-8000-0000000000a1", requestId: "r1" };
    state.resolve = { ok: true, value: ctx };
    expect(await gate()).toBe(ctx);
    expect(resolveAdminContext).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: ctx.userId, twoFactorEnabled: true }),
    );
  });
});
