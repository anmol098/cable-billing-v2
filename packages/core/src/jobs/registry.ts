/**
 * The handler registry the job worker uses (T-043).
 *
 * ```ts
 * import * as core from "@cb/core";
 * const registry = createJobRegistry(collectJobDefinitions(core)); // every exported defineJob(...)
 * registry.register(someWebOnlyJob);                                // or add one by hand
 * ```
 *
 * Feature tasks never edit this file: they export a `defineJob(...)` value from their own module,
 * `packages/core/src/index.ts` re-exports it, and `collectJobDefinitions` picks it up.
 * A registry is a value made by a factory (no module-level state), so importing core registers
 * nothing as a side effect.
 */
import type { AnyJobDefinition } from "./definition";
import { isJobDefinition } from "./definition";

export interface JobRegistry {
  /** Adds a definition. Throws on a duplicate type (two handlers for one type is a bug). */
  register(definition: AnyJobDefinition): JobRegistry;
  /** Shorthand for `register`, by type and definition (the type must match). */
  registerJob(type: string, definition: AnyJobDefinition): JobRegistry;
  get(type: string): AnyJobDefinition | undefined;
  has(type: string): boolean;
  /** Registered types, sorted (the worker claims only these). */
  types(): string[];
}

export function createJobRegistry(definitions: Iterable<AnyJobDefinition> = []): JobRegistry {
  const byType = new Map<string, AnyJobDefinition>();
  const registry: JobRegistry = {
    register(definition) {
      if (!isJobDefinition(definition)) {
        throw new TypeError("register: not a job definition (use defineJob)");
      }
      const existing = byType.get(definition.type);
      if (existing && existing !== definition) {
        throw new Error(`Job type "${definition.type}" is registered twice`);
      }
      byType.set(definition.type, definition);
      return registry;
    },
    registerJob(type, definition) {
      if (definition.type !== type) {
        throw new TypeError(`registerJob: type "${type}" does not match "${definition.type}"`);
      }
      return registry.register(definition);
    },
    get: (type) => byType.get(type),
    has: (type) => byType.has(type),
    types: () => [...byType.keys()].sort(),
  };
  for (const definition of definitions) registry.register(definition);
  return registry;
}

/**
 * Every job definition among a module's exports (e.g. `import * as core from "@cb/core"`), each
 * once. Throws when two different definitions share a type.
 */
export function collectJobDefinitions(moduleExports: Record<string, unknown>): AnyJobDefinition[] {
  const found = new Map<string, AnyJobDefinition>();
  for (const [name, value] of Object.entries(moduleExports)) {
    if (!isJobDefinition(value)) continue;
    const existing = found.get(value.type);
    if (existing && existing !== value) {
      throw new Error(`Job type "${value.type}" is defined twice (export ${name})`);
    }
    found.set(value.type, value);
  }
  return [...found.values()];
}
