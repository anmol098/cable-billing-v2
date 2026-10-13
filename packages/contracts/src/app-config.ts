/** `GET /app/config` (PLAN §10.2, §11.9): the force-update gate, operator details and tenant mode. */

import * as z from "zod";
import { OperatorInfo } from "./auth";
import { responseBody } from "./envelope";

export const TenantMode = z.enum(["normal", "read_only"]).meta({
  id: "TenantMode",
  description:
    "'normal', or 'read_only' when the operator's subscription lapsed (D-13). The app keeps collecting and syncing normally in read_only and shows no banner to linemen.",
});

export const AppConfigResponse = responseBody(
  "AppConfigResponse",
  "Settings the app reads on start and after every sync.",
  {
    min_app_version_code: z
      .int()
      .min(1)
      .describe(
        "The lowest Android versionCode the server accepts. If the installed app is older, show only the full-screen 'Update app' button; queued payments stay on the phone and sync after the update.",
      ),
    operator: OperatorInfo.describe("The lineman's operator (name, office phone, receipt footer)."),
    tenant_mode: TenantMode.describe("Whether the operator is in normal or read-only mode."),
    features: z
      .record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.boolean())
      .describe(
        "Feature flags by name (snake_case). A missing flag means off; unknown flags must be ignored. New flags may appear at any time within v1.",
      ),
  },
);

export type AppConfigResponse = z.infer<typeof AppConfigResponse>;
