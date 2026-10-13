// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type VercelConfig = {
  regions: string[];
  crons: Array<{ path: string; schedule: string }>;
};

const config = JSON.parse(
  readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
) as VercelConfig;

/** One cron field: `*`, `*\/n`, a number, a range or a list of those. */
const FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/;

describe("vercel.json", () => {
  it("pins functions to a single region (co-located with Neon, E-06)", () => {
    expect(config.regions).toHaveLength(1);
    expect(config.regions[0]).toMatch(/^[a-z]{3}\d$/);
  });

  it("schedules only /api/cron/* routes, each once, with 5-field UTC cron expressions", () => {
    const paths = config.crons.map((cron) => cron.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const { path, schedule } of config.crons) {
      expect(path).toMatch(/^\/api\/cron\/[a-z0-9-]+$/);
      const fields = schedule.split(" ");
      expect(fields).toHaveLength(5);
      for (const field of fields) expect(field).toMatch(FIELD);
    }
  });

  it("has the PLAN §14 jobs", () => {
    expect(
      Object.fromEntries(config.crons.map((cron) => [cron.path, cron.schedule])),
    ).toMatchObject({
      "/api/cron/billing-scheduler": "45 18 * * *",
      "/api/cron/job-worker": "*/2 * * * *",
      "/api/cron/subscription-states": "30 0 * * *",
      "/api/cron/session-close": "0 19 * * *",
      "/api/cron/invariants": "0 21 * * *",
    });
    expect(config.crons.some((cron) => cron.path === "/api/cron/receipt-links-cleanup")).toBe(true);
  });
});
