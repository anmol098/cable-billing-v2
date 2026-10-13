/**
 * A fake feature module for the coverage test (src/testing/coverage.test.ts): three services, of
 * which `exportWidgets` has no isolation cases. Never called.
 */
import { err, ok } from "@cb/domain";
import { z } from "zod";
import { defineService } from "../../../../context/service";
import { notFound } from "../../../../errors/errors";

export const getWidget = defineService({
  name: "widgets.get",
  capability: "dashboard.view",
  input: z.object({ widgetId: z.uuid() }),
  async run({ input }) {
    return input.widgetId ? err(notFound()) : ok(null);
  },
});

export const listWidgets = defineService({
  name: "widgets.list",
  capability: "dashboard.view",
  input: z.object({ search: z.string().optional() }),
  async run() {
    return ok([]);
  },
});

export const exportWidgets = defineService({
  name: "widgets.export",
  capability: "exports.csv",
  input: z.object({}),
  async run({ audit }) {
    await audit.record({ entityType: "widget", after: { exported: 0 } });
    return ok("");
  },
});
