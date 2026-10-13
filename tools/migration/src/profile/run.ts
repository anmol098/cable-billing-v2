import type pg from "pg";
import { collectForbiddenValues } from "../pii/forbidden";
import { type PiiFinding, scanForPii } from "../pii/scan";
import { readCatalog } from "./catalog";
import { collectProfile } from "./collect";
import { renderProfile } from "./render";
import type { Profile } from "./types";

export interface ProfileRun {
  readonly profile: Profile;
  readonly markdown: string;
  /** PII check findings. Non-empty means the markdown must not be written anywhere. */
  readonly findings: readonly PiiFinding[];
}

/** Catalog → forbidden values → profile → markdown → PII check. Nothing is written here. */
export async function runProfile(
  client: pg.ClientBase,
  now: Date = new Date(),
): Promise<ProfileRun> {
  const catalog = await readCatalog(client);
  const forbidden = await collectForbiddenValues(client, catalog);
  const profile = await collectProfile(client, catalog, forbidden, now);
  const markdown = renderProfile(profile);
  return { profile, markdown, findings: scanForPii(markdown, forbidden) };
}
