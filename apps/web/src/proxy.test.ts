import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTH_COOKIE_PREFIX } from "@cb/core";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import {
  isProtectedPath,
  PATHNAME_HEADER,
  PROTECTED_PREFIXES,
  SESSION_COOKIE_NAMES,
} from "@/lib/auth/paths";
import { config, proxy } from "./proxy";

const request = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, cookie ? { headers: { cookie } } : {});

describe("proxy (optimistic sign-in check)", () => {
  it("sends a visitor without a session cookie to /login with the page they asked for", () => {
    const response = proxy(request("/customers?q=ram"));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/customers?q=ram");
  });

  it("lets a request with a session cookie (secure or not) through, passing the path on", () => {
    for (const name of SESSION_COOKIE_NAMES) {
      const response = proxy(request("/admin/tenants", `${name}=abc.def`));
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("x-middleware-request-x-cb-pathname")).toBe("/admin/tenants");
    }
    expect(PATHNAME_HEADER).toBe("x-cb-pathname");
  });

  it("ignores other cookies (a look-alike name is not a session)", () => {
    const response = proxy(request("/home", "better-auth.session_token=x; cb.session=y"));
    expect(response.status).toBe(307);
  });

  it("matches exactly the protected prefixes (matcher, list and core cookie prefix agree)", () => {
    expect(config.matcher).toEqual(PROTECTED_PREFIXES.map((prefix) => `${prefix}/:path*`));
    expect(SESSION_COOKIE_NAMES).toEqual([
      `__Secure-${AUTH_COOKIE_PREFIX}.session_token`,
      `${AUTH_COOKIE_PREFIX}.session_token`,
    ]);
    expect(isProtectedPath("/admin")).toBe(true);
    expect(isProtectedPath("/settings/team")).toBe(true);
    expect(isProtectedPath("/homework")).toBe(false);
    expect(isProtectedPath("/login")).toBe(false);
    expect(isProtectedPath("/r/abc")).toBe(false);
    expect(isProtectedPath("/")).toBe(false);
  });

  it("is the Next 16 proxy file; there is no deprecated middleware.ts next to it", () => {
    const src = join(process.cwd(), "src");
    expect(readFileSync(join(src, "proxy.ts"), "utf8")).toContain("export function proxy(");
    expect(existsSync(join(src, "middleware.ts"))).toBe(false);
  });
});
