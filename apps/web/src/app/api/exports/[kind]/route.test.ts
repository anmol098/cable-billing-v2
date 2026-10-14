// @vitest-environment node
/**
 * `GET /api/exports/<kind>` (T-082): Owner only (Staff and linemen 403 without opening anything),
 * cross-site starts refused, unknown kinds 404, refusals from `openExport` mapped to the download
 * page with the reason, and a successful export streamed as a private, never-cached CSV attachment
 * named by its "as of" time. `openExport` itself (audit, rate limit, isolation) is tested against a
 * real database in `@cb/core` (packages/core/src/exports).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { allWords, SAMPLE_ROWS } from "@/app/(operator)/reports/_export/test-fixtures";

const state = vi.hoisted(() => ({ role: "owner" as "owner" | "staff" | "lineman" }));
const openExport = vi.hoisted(() => vi.fn());
const limiter = vi.hoisted(() => ({ kind: "memory", hit: vi.fn() }));

vi.mock("@cb/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cb/core")>()),
  openExport,
}));
vi.mock("@/lib/auth/session", () => ({
  getTenantContext: vi.fn(async () => ({
    role: state.role,
    operatorId: "0199c4f6-0000-7000-8000-000000000001",
    userId: "0199c4f6-0000-7000-8000-000000000002",
    requestId: "req-1",
  })),
}));
vi.mock("@/lib/auth/server", async () => {
  const { silentLogger } = await import("@cb/core");
  return {
    getServerRuntime: () => ({
      now: () => new Date("2026-11-02T04:30:00.000Z"),
      logger: silentLogger,
    }),
    getRateLimiter: () => limiter,
  };
});
vi.mock("next-intl/server", () => ({ getTranslations: async () => allWords("en") }));

const { GET } = await import("./route");

const call = (slug: string, query = "", headers: Record<string, string> = {}) =>
  GET(new Request(`http://localhost/api/exports/${slug}${query}`, { headers }), {
    params: Promise.resolve({ kind: slug }),
  });

describe("GET /api/exports/<kind>", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.role = "owner";
  });

  it("refuses Staff and linemen with 403 before opening an export", async () => {
    for (const role of ["staff", "lineman"] as const) {
      state.role = role;
      const response = await call("customers");
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("Only the owner can download data.");
    }
    expect(openExport).not.toHaveBeenCalled();
  });

  it("404 for an unknown kind; 403 when another site starts the download", async () => {
    expect((await call("audit")).status).toBe(404);
    expect((await call("customers", "", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(openExport).not.toHaveBeenCalled();
  });

  it("passes the page's filters and the rate limiter to openExport", async () => {
    openExport.mockResolvedValueOnce({ ok: false, error: { code: "NOT_FOUND" } });
    await call("billing-runs", "?month=2026-10-01&page=2");
    expect(openExport).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ role: "owner" }),
      {
        kind: "billing_runs",
        filters: { period: "2026-10-01", outcome: undefined, areaId: undefined },
      },
      { rateLimiter: limiter },
    );
  });

  it("sends refusals back to the download page with the reason", async () => {
    const cases = [
      [{ code: "VALIDATION" }, "/reports/export?problem=bad_filters"],
      [{ code: "NOT_FOUND" }, "/reports/export?problem=not_found"],
      [
        { code: "RATE_LIMITED", details: { retryAfterSeconds: 125 } },
        "/reports/export?problem=too_many&wait=3",
      ],
      [{ code: "INTERNAL" }, "/reports/export?problem=failed"],
    ] as const;
    for (const [error, location] of cases) {
      openExport.mockResolvedValueOnce({ ok: false, error });
      const response = await call("dues");
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(location);
    }
    openExport.mockResolvedValueOnce({ ok: false, error: { code: "FORBIDDEN" } });
    expect((await call("dues")).status).toBe(403);
  });

  it("streams the CSV as a private attachment named by its as-of time", async () => {
    openExport.mockResolvedValueOnce({
      ok: true,
      value: {
        kind: "customers",
        filters: {},
        asOf: new Date("2026-11-02T04:30:00.000Z"),
        truncated: false,
        async *pages() {
          yield [SAMPLE_ROWS.customers];
        },
      },
    });
    const response = await call("customers");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="customers-2026-11-02-1000.csv"',
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text.split("\r\n")[1]).toContain("A-1,\"'=HYPERLINK");
  });
});
