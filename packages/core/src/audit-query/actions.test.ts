/**
 * Every audit action the code writes has a sentence (T-035): the viewer must never show an Owner
 * a raw `customers.update_phone`. Finds the actions three ways, so a new writer can't slip past:
 *
 * 1. **Service defaults**: every service whose capability is audited, or a write service in a
 *    file that calls `audit.record(` (its name is the default action of `audit.record`),
 *    discovered by importing `packages/core/src` like the isolation harness does.
 * 2. **Literals in the source** of packages/core, apps/web and tools (tests excluded): an
 *    `action: "…"` property, a string argument of any call whose name contains "audit"
 *    (`auditRunChange(audit, run, "billing.run_started")`, `audit("auth.…", …)`), and the auth
 *    module's `AUTH_AUDIT_ACTIONS` list.
 * 3. **Templates** (`` action: `connections.${command.action}` ``) must be listed in
 *    {@link TEMPLATE_ACTIONS} with every value they can take; an unknown template fails.
 *
 * Then: every found action is in `AUDIT_ACTIONS`, every `AUDIT_ACTIONS` entry is still written
 * somewhere (no stale sentences), and each has `sentence.<action>` and `action.<action>` in both
 * `audit.json` files, with the placeholders its details provide.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUTH_AUDIT_ACTIONS } from "../auth/audit-events";
import { CAPABILITIES } from "../authz/capabilities";
import { discoverServices } from "../testing/discovery";
import { AUDIT_ACTIONS, auditDetails, KNOWN_AUDIT_ACTIONS } from "./actions";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const SCANNED_ROOTS = ["packages/core/src", "apps/web/src", "tools"];
const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** Template literals that make an action, and every action each can make. */
const TEMPLATE_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  // packages/core/src/connections/services.ts: StatusAction = suspend | reactivate | disconnect.
  "connections.${command.action}": [
    "connections.suspend",
    "connections.reactivate",
    "connections.disconnect",
  ],
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "testing", "e2e", ".next", "dist", "fixtures"].includes(entry.name)) {
        continue;
      }
      sourceFiles(path, out);
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.(test|spec)\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.endsWith(".isolation.ts")
    ) {
      out.push(path);
    }
  }
  return out;
}

/** The text between the `(` at `open` and its matching `)` (strings and nesting respected). */
function callArguments(source: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return "";
}

interface Found {
  readonly action: string;
  readonly where: string;
}

function scanSource(): { literals: Found[]; templates: Found[] } {
  const literals: Found[] = [];
  const templates: Found[] = [];
  for (const root of SCANNED_ROOTS) {
    for (const file of sourceFiles(join(REPO, root))) {
      const where = relative(REPO, file).split(sep).join("/");
      // The viewer's own registry and readers are not writers.
      if (where.startsWith("packages/core/src/audit-query/")) continue;
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/\baction:\s*"([^"]+)"/g)) {
        if (m[1] && ACTION.test(m[1])) literals.push({ action: m[1], where });
      }
      for (const m of source.matchAll(/\baction:\s*`([^`]*)`/g)) {
        templates.push({ action: m[1] ?? "", where });
      }
      for (const m of source.matchAll(/\b\w*[aA]udit\w*\s*\(/g)) {
        const args = callArguments(source, (m.index ?? 0) + m[0].length - 1);
        for (const s of args.matchAll(/"([^"\n]+)"/g)) {
          if (s[1] && ACTION.test(s[1])) literals.push({ action: s[1], where });
        }
      }
    }
  }
  return { literals, templates };
}

/**
 * Audited services whose own name is never written as an action, with why. Their capability is
 * audited, so they would otherwise count as writing their default action.
 */
const NEVER_THE_DEFAULT_ACTION: Readonly<Record<string, string>> = {
  "subscriptions.overview": "a read that always calls audit.skip('no_change')",
  "subscriptions.record_checkout": "always records `subscriptions.checkout_started`",
  "adjustments.create_manual": "records `adjustments.create` (through `insertAdjustment`)",
};

async function writtenActions(): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const { literals, templates } = scanSource();
  for (const { action, where } of literals) if (!found.has(action)) found.set(action, where);
  for (const { action, where } of templates) {
    const expansions = TEMPLATE_ACTIONS[action];
    if (!expansions) {
      throw new Error(
        `${where}: audit action template \`${action}\` is not in TEMPLATE_ACTIONS; list every action it can make`,
      );
    }
    for (const expanded of expansions) found.set(expanded, where);
  }
  for (const action of AUTH_AUDIT_ACTIONS)
    found.set(action, "packages/core/src/auth/audit-events.ts");
  // The file that defines each service (`name: "…"`); discovery may find it via an index re-export.
  const definedIn = new Map<string, string>();
  for (const file of sourceFiles(join(REPO, "packages/core/src"))) {
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/\bname:\s*"([a-z][a-z0-9_.]*)"/g)) {
      if (m[1]) definedIn.set(m[1], source);
    }
  }
  for (const { service, file } of await discoverServices()) {
    const spec = CAPABILITIES[service.capability as keyof typeof CAPABILITIES];
    // Audited capabilities must record; write services of other capabilities may (e.g.
    // `receipts.share`, whose link services record without being required to).
    const records =
      spec?.audited ||
      (spec?.kind === "write" && (definedIn.get(service.name) ?? "").includes("audit.record("));
    if (records && !Object.hasOwn(NEVER_THE_DEFAULT_ACTION, service.name))
      found.set(service.name, `packages/core/src/${file} (service default)`);
  }
  return found;
}

function messages(locale: "en" | "hi"): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(REPO, `packages/i18n/messages/${locale}/audit.json`), "utf8"),
  ) as Record<string, unknown>;
}

function lookup(tree: Record<string, unknown>, path: string): unknown {
  let node: unknown = tree;
  for (const part of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** `{name}` / `{name, select, …}` / `{name, plural, …}` argument names of an ICU message. */
function placeholders(message: string): Set<string> {
  return new Set([...message.matchAll(/\{\s*([a-z_]+)\s*(?:,|\})/g)].map((m) => m[1] ?? ""));
}

/** Placeholders the web always fills (./present.ts + the page's sentence builder). */
const ALWAYS = new Set(["who", "target"]);

describe("audit action sentences (T-035)", () => {
  it("finds the actions written today (sanity check of the scanner)", async () => {
    const found = await writtenActions();
    for (const action of [
      "customers.update_phone", // service default
      "connections.change_plan", // action: "…"
      "connections.suspend", // template
      "billing.run_started", // auditRunChange(audit, run, "…")
      "billing.run_skipped", // audit(row, "…")
      "auth.password_reset_requested", // AUTH_AUDIT_ACTIONS
      "receipt_links.purged", // ctx.audit(tx, { action: "…" })
      "mobile_auth.refresh_reuse_detected", // writeAuditEvent(tx, { action: "…" })
    ]) {
      expect(found.has(action), action).toBe(true);
    }
  }, 60_000);

  it("every action written anywhere has a registry entry, and every entry is still written", async () => {
    const found = await writtenActions();
    const missing = [...found].filter(([action]) => !Object.hasOwn(AUDIT_ACTIONS, action));
    expect(
      missing.map(([action, where]) => `${action} (${where})`),
      "add these to AUDIT_ACTIONS (packages/core/src/audit-query/actions.ts) and audit.json (a service that never records its own name: NEVER_THE_DEFAULT_ACTION here)",
    ).toEqual([]);
    const stale = KNOWN_AUDIT_ACTIONS.filter((action) => !found.has(action));
    expect(stale, "no code writes these any more: remove them").toEqual([]);
  }, 60_000);

  it("every registered action has a sentence and a filter label in English and Hindi", () => {
    for (const locale of ["en", "hi"] as const) {
      const tree = messages(locale);
      for (const action of KNOWN_AUDIT_ACTIONS) {
        const sentence = lookup(tree, `sentence.${action}`);
        expect(typeof sentence, `${locale}: sentence.${action}`).toBe("string");
        expect(typeof lookup(tree, `action.${action}`), `${locale}: action.${action}`).toBe(
          "string",
        );
        expect(placeholders(String(sentence)).has("who"), `${locale}: ${action} says who`).toBe(
          true,
        );
      }
    }
  });

  it("the generic sentence (unknown actions) and the entity words exist", () => {
    for (const locale of ["en", "hi"] as const) {
      const tree = messages(locale);
      expect(placeholders(String(lookup(tree, "generic")))).toEqual(
        new Set(["who", "entity", "target"]),
      );
      for (const key of ["who.person", "who.someone", "who.app", "who.support", "entity.other"]) {
        expect(typeof lookup(tree, key), `${locale}: ${key}`).toBe("string");
      }
    }
  });

  it("each sentence uses only placeholders the event can provide", () => {
    // The details an action can give (every extractor run on an empty event lists none, so use
    // the declared names: what the extractors return plus the entity label's context).
    const labelExtras = new Set(["customer", "date"]);
    const tree = messages("en");
    for (const action of KNOWN_AUDIT_ACTIONS) {
      const spec = AUDIT_ACTIONS[action] as { details?: (d: unknown) => Record<string, unknown> };
      const provided = new Set([
        ...ALWAYS,
        ...labelExtras,
        ...Object.keys(spec.details?.({ before: {}, after: {} }) ?? {}),
      ]);
      const used = placeholders(String(lookup(tree, `sentence.${action}`)));
      for (const name of used) expect(provided.has(name), `${action}: {${name}}`).toBe(true);
    }
  });

  it("detail extractors read real event shapes", () => {
    expect(
      auditDetails("connections.change_plan", {
        before: { planId: null, rentalPaise: 30_000 },
        after: { planId: null, rentalPaise: 35_000, effectiveDate: "2026-10-01" },
      }),
    ).toEqual({ from: { kind: "paise", value: 30_000 }, to: { kind: "paise", value: 35_000 } });
    expect(
      auditDetails("customers.update", {
        before: { altPhone: null, customerCode: "1" },
        after: { altPhone: "9876543210", customerCode: "2" },
      }),
    ).toEqual({ fields: { kind: "fields", value: ["alt_phone", "customer_code"] } });
    expect(
      auditDetails("customers.update_phone", {
        before: { altPhone: null },
        after: { altPhone: "1" },
      }),
    ).toEqual({ field: { kind: "code", value: "alt_phone" } });
    expect(
      auditDetails("payments.post", {
        before: null,
        after: { amount_paise: 5000, method: "cash" },
      }),
    ).toEqual({ amount: { kind: "paise", value: 5000 }, method: { kind: "code", value: "cash" } });
    // Free text never becomes a select code; unknown actions give nothing.
    expect(
      auditDetails("customers.set_status", { before: null, after: { status: "Call 98765" } }),
    ).toEqual({});
    expect(
      auditDetails("some.future_action", { before: null, after: { amount_paise: 1 } }),
    ).toEqual({});
  });
});
