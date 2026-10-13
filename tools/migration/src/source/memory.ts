import type { LegacySource, LegacyTable, LegacyValue } from "./types";

export interface MemoryTable extends LegacyTable {
  readonly rows: readonly (readonly LegacyValue[])[];
}

/** A legacy source backed by in-memory tables (the synthetic fixture). Used by tests. */
export class MemorySource implements LegacySource {
  readonly label: string;
  readonly #tables: readonly MemoryTable[];

  constructor(tables: readonly MemoryTable[], label = "memory") {
    this.#tables = [...tables].sort((a, b) => a.name.localeCompare(b.name));
    this.label = label;
  }

  async listTables(): Promise<LegacyTable[]> {
    return this.#tables.map(({ name, columns }) => ({ name, columns }));
  }

  async countRows(table: LegacyTable): Promise<number> {
    return this.#find(table).rows.length;
  }

  async *readRows(table: LegacyTable, batchSize: number): AsyncIterable<LegacyValue[][]> {
    const { rows } = this.#find(table);
    for (let i = 0; i < rows.length; i += batchSize) {
      yield rows.slice(i, i + batchSize).map((row) => [...row]);
    }
  }

  async close(): Promise<void> {}

  #find(table: LegacyTable): MemoryTable {
    const found = this.#tables.find((t) => t.name === table.name);
    if (!found) throw new Error(`no such table: ${table.name}`);
    return found;
  }
}
