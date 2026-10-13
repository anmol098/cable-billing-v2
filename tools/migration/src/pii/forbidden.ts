import type pg from "pg";
import { quotePgIdent } from "../copy/types";
import { type Catalog, qualified } from "../profile/catalog";
import { ForbiddenValues } from "./scan";

/**
 * Collects the values a profile must never contain from the copied legacy data: every distinct
 * value of every identifying column, and the single words of person-name columns. Table names,
 * column names and source types are registered as ignored (they are in the profile by design).
 *
 * The values stay in this process's memory and are never printed.
 */
export async function collectForbiddenValues(
  client: pg.ClientBase,
  catalog: Catalog,
): Promise<ForbiddenValues> {
  const forbidden = new ForbiddenValues();
  for (const table of catalog.tables) {
    forbidden.addIgnored(table.name);
    for (const column of table.columns) {
      forbidden.addIgnored(column.name);
      forbidden.addIgnored(column.columnType);
    }
  }
  for (const table of catalog.tables) {
    for (const column of table.columns) {
      if (!column.classification.identifying || column.kind === "binary") continue;
      const source = `${table.name}.${column.name}`;
      const result = await client.query<{ v: string }>(
        `SELECT DISTINCT ${quotePgIdent(column.name)}::text AS v FROM ${qualified(table.name)}
          WHERE ${quotePgIdent(column.name)} IS NOT NULL`,
      );
      for (const { v } of result.rows) {
        forbidden.addValue(v, source);
        if (column.classification.personName) forbidden.addNameWords(v, source);
      }
    }
  }
  return forbidden;
}
