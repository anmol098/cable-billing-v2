/**
 * Customer read services (T-033; FR-003, PLAN §12.1). All use `customers.view` (Owner, Staff,
 * Lineman; not audited, so they run in a READ ONLY transaction).
 *
 * | Service | What |
 * |---|---|
 * | `customers.search` | The list page and customer pickers: ranked search by code, phone, VC number and name, area/status filters, pages |
 * | `customers.get` | One customer for the profile header and Summary tab: details, area, balance, open connections, last payment |
 * | `customers.form_options` | Areas for the form and the list filter, and the next auto code (preview) |
 *
 * **Search ranking** (`SEARCH_TIERS`, lower first): exact code → exact phone / VC number of an open
 * connection → code prefix → phone / open VC prefix → name starts with → a word of the name starts
 * with → phone or name contains → VC of a past connection → similar name (typos, pg_trgm word
 * similarity). Ties: name similarity, then the code in natural order (1, 2, 10, then A-1…), then
 * id. Without text every customer matches (`match: "all"`) in natural code order.
 * Each branch uses an index from T-022 (code/phone/VC `text_pattern_ops` prefix indexes, GIN
 * trigram on the name); see the completion notes for measured timings.
 */
import { areas, type CustomerStatus, counters, customers } from "@cb/db";
import { err, ok } from "@cb/domain";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { defineService } from "../context/service";
import { notFound } from "../errors/errors";
import {
  escapeLike,
  MIN_PHONE_CONTAINS,
  MIN_PHONE_PREFIX,
  NAME_SIMILARITY_THRESHOLD,
  type SearchMatchKind,
  searchTerms,
  SEARCH_TIERS as T,
} from "./rules";
import type {
  CustomerConnectionSummary,
  CustomerFormOptions,
  CustomerListRow,
  CustomerProfile,
  CustomerSearchResult,
} from "./types";

const id = () => z.uuid().transform((value) => value.toLowerCase());

/** Rows per page by default, and at most. */
export const CUSTOMER_PAGE_SIZE = 50;
export const MAX_CUSTOMER_PAGE_SIZE = 100;
/** Deepest offset (pages beyond this: search instead). */
export const MAX_CUSTOMER_OFFSET = 10_000;

export const SearchCustomersInput = z.object({
  /** Search box text; empty = everyone. */
  q: z.string().max(500).optional(),
  /** An area id, or `none` for customers without an area. */
  areaId: z.union([id(), z.literal("none")]).optional(),
  /** Default `all`. */
  status: z.enum(["all", "active", "inactive"]).default("all"),
  limit: z.number().int().min(1).max(MAX_CUSTOMER_PAGE_SIZE).default(CUSTOMER_PAGE_SIZE),
  offset: z.number().int().min(0).max(MAX_CUSTOMER_OFFSET).default(0),
});
export type SearchCustomersCommand = z.output<typeof SearchCustomersInput>;

/** A ranking tier as a SQL integer literal (a bind parameter would be untyped in the UNION). */
const tier = (value: number) => sql.raw(String(Math.trunc(value)));

/**
 * Natural order of codes: all-digit codes by number (1, 2, 10), then the rest by their bytes
 * (`COLLATE "C"`: the same order on every server, whatever its locale).
 */
const NATURAL_CODE_ORDER = sql.raw(
  `(c.customer_code_norm ~ '^[0-9]+$') DESC,
   CASE WHEN c.customer_code_norm ~ '^[0-9]+$' THEN length(c.customer_code_norm) END,
   c.customer_code_norm COLLATE "C"`,
);

interface SearchRow extends Record<string, unknown> {
  id: string;
  customer_code: string;
  name: string;
  phone: string | null;
  area_id: string | null;
  area_name: string | null;
  status: CustomerStatus;
  balance_paise: string | number;
  credit_paise: string | number;
  via: SearchMatchKind;
  vc_number: string | null;
}

/**
 * The SQL of a ranked search (also used by the performance check). `operatorId` is repeated in
 * every branch so each one can use its `(operator_id, …)` index; RLS limits the rows as well.
 */
export function customerSearchSql(operatorId: string, command: SearchCustomersCommand) {
  const terms = searchTerms(command.q);
  const filters = [sql`TRUE`];
  if (command.status !== "all") filters.push(sql`c.status = ${command.status}::customer_status`);
  if (command.areaId === "none") filters.push(sql`c.area_id IS NULL`);
  else if (command.areaId) filters.push(sql`c.area_id = ${command.areaId}::uuid`);
  const where = sql.join(filters, sql` AND `);
  const pageSize = command.limit + 1;

  const select = sql`
    c.id, c.customer_code, c.name, c.phone, c.area_id, a.name AS area_name, c.status,
    coalesce(b.balance_paise, 0) AS balance_paise, coalesce(b.credit_paise, 0) AS credit_paise`;
  const joins = sql`
    LEFT JOIN areas a ON a.operator_id = c.operator_id AND a.id = c.area_id
    LEFT JOIN customer_balances b ON b.operator_id = c.operator_id AND b.customer_id = c.id`;

  if (terms.text === "") {
    return sql`
      SELECT ${select}, 'all' AS via, NULL::text AS vc_number
      FROM customers c ${joins}
      WHERE c.operator_id = ${operatorId}::uuid AND ${where}
      ORDER BY ${NATURAL_CODE_ORDER}, c.id
      LIMIT ${pageSize} OFFSET ${command.offset}`;
  }

  const op = sql`${operatorId}::uuid`;
  const branches = [
    sql`SELECT c.id, CASE WHEN c.customer_code_norm = ${terms.code} THEN ${tier(T.codeExact)}
          ELSE ${tier(T.codePrefix)} END AS tier, 'code' AS via, NULL::text AS vc_number
        FROM customers c
        WHERE c.operator_id = ${op}
          AND c.customer_code_norm LIKE ${`${escapeLike(terms.code)}%`} ESCAPE '\\'`,
  ];
  if (terms.digits && terms.digits.length >= MIN_PHONE_PREFIX) {
    const d = terms.digits;
    branches.push(
      sql`SELECT c.id, CASE WHEN c.phone = ${d} OR c.alt_phone = ${d} THEN ${tier(T.phoneOrVcExact)}
            ELSE ${tier(T.phoneOrVcPrefix)} END, 'phone', NULL
          FROM customers c
          WHERE c.operator_id = ${op}
            AND (c.phone LIKE ${`${d}%`} OR c.alt_phone LIKE ${`${d}%`})`,
    );
    if (d.length >= MIN_PHONE_CONTAINS) {
      branches.push(
        sql`SELECT c.id, ${tier(T.contains)}, 'phone', NULL
            FROM customers c
            WHERE c.operator_id = ${op}
              AND (c.phone LIKE ${`%${d}%`} OR c.alt_phone LIKE ${`%${d}%`})`,
      );
    }
  }
  if (terms.vc) {
    branches.push(
      sql`SELECT s.customer_id, CASE WHEN s.status = 'disconnected' THEN ${tier(T.pastVc)}
            WHEN v.vc_number_norm = ${terms.vc} THEN ${tier(T.phoneOrVcExact)}
            ELSE ${tier(T.phoneOrVcPrefix)} END, 'vc', v.vc_number
          FROM vc_assets v
          JOIN vc_assignments s ON s.operator_id = v.operator_id AND s.vc_asset_id = v.id
          WHERE v.operator_id = ${op}
            AND v.vc_number_norm LIKE ${`${escapeLike(terms.vc)}%`} ESCAPE '\\'`,
    );
  }
  const text = terms.text;
  const like = escapeLike(text);
  // Name starts with / a word starts with / contains. One letter: starts with only.
  branches.push(
    sql`SELECT c.id, CASE WHEN c.name ILIKE ${`${like}%`} ESCAPE '\\' THEN ${tier(T.namePrefix)}
          WHEN c.name ILIKE ${`% ${like}%`} ESCAPE '\\' THEN ${tier(T.nameWord)}
          ELSE ${tier(T.contains)} END, 'name', NULL
        FROM customers c
        WHERE c.operator_id = ${op}
          AND c.name ILIKE ${terms.nameContains ? `%${like}%` : `${like}%`} ESCAPE '\\'`,
  );
  if (terms.nameFuzzy) {
    branches.push(
      sql`SELECT c.id, ${tier(T.nameSimilar)}, 'name', NULL
          FROM customers c
          WHERE c.operator_id = ${op} AND ${text} <% c.name`,
    );
  }

  return sql`
    WITH matches (id, tier, via, vc_number) AS (${sql.join(branches, sql` UNION ALL `)}),
    best AS (
      SELECT DISTINCT ON (id) id, tier, via, vc_number FROM matches ORDER BY id, tier, vc_number
    )
    SELECT ${select}, m.via, m.vc_number
    FROM best m
    JOIN customers c ON c.operator_id = ${op} AND c.id = m.id
    ${joins}
    WHERE ${where}
    ORDER BY m.tier, word_similarity(${text}, c.name) DESC, ${NATURAL_CODE_ORDER}, c.id
    LIMIT ${pageSize} OFFSET ${command.offset}`;
}

function toListRow(row: SearchRow): CustomerListRow {
  return {
    id: row.id,
    customerCode: row.customer_code,
    name: row.name,
    phone: row.phone,
    areaId: row.area_id,
    areaName: row.area_name,
    status: row.status,
    balancePaise: Number(row.balance_paise),
    creditPaise: Number(row.credit_paise),
    match: row.via,
    matchedVcNumber: row.via === "vc" ? row.vc_number : null,
  };
}

export const searchCustomers = defineService({
  name: "customers.search",
  capability: "customers.view",
  input: SearchCustomersInput,
  async run({ ctx, input, tx }) {
    if (input.areaId && input.areaId !== "none") {
      const [area] = await tx
        .select({ id: areas.id })
        .from(areas)
        .where(and(eq(areas.operatorId, ctx.operatorId), eq(areas.id, input.areaId)));
      if (!area) return err(notFound());
    }
    await tx.execute(
      sql`SELECT set_config('pg_trgm.word_similarity_threshold', ${String(NAME_SIMILARITY_THRESHOLD)}, true)`,
    );
    const result = await tx.execute<SearchRow>(customerSearchSql(ctx.operatorId, input));
    const rows = result.rows.slice(0, input.limit).map(toListRow);
    const value: CustomerSearchResult = { rows, hasMore: result.rows.length > input.limit };
    return ok(value);
  },
});

// ---------------------------------------------------------------------------------------------

export const GetCustomerInput = z.object({ customerId: id() });

interface ProfileRow extends Record<string, unknown> {
  area_name: string | null;
  balance_paise: string | number | null;
  credit_paise: string | number | null;
  oldest_due_period: string | null;
}

interface ConnectionRow extends Record<string, unknown> {
  assignment_id: string;
  vc_asset_id: string;
  vc_number: string;
  status: CustomerConnectionSummary["status"];
  plan_id: string | null;
  plan_name: string | null;
  rental_amount_paise: string | number;
  start_date: string;
  end_date: string | null;
}

interface LastPaymentRow extends Record<string, unknown> {
  id: string;
  amount_paise: string | number;
  method: "cash" | "upi";
  business_date: string;
  reversed: boolean;
}

export const getCustomer = defineService({
  name: "customers.get",
  capability: "customers.view",
  input: GetCustomerInput,
  async run({ ctx, input, tx }) {
    const op = ctx.operatorId;
    const [customer] = await tx
      .select()
      .from(customers)
      .where(and(eq(customers.operatorId, op), eq(customers.id, input.customerId)));
    if (!customer) return err(notFound());

    const extra = await tx.execute<ProfileRow>(sql`
      SELECT a.name AS area_name, b.balance_paise, b.credit_paise,
        b.oldest_due_period::text AS oldest_due_period
      FROM customers c
      LEFT JOIN areas a ON a.operator_id = c.operator_id AND a.id = c.area_id
      LEFT JOIN customer_balances b ON b.operator_id = c.operator_id AND b.customer_id = c.id
      WHERE c.operator_id = ${op}::uuid AND c.id = ${customer.id}::uuid`);
    const connections = await tx.execute<ConnectionRow>(sql`
      SELECT s.id AS assignment_id, v.id AS vc_asset_id, v.vc_number, s.status, s.plan_id,
        p.name AS plan_name, s.rental_amount_paise, s.start_date::text AS start_date,
        s.end_date::text AS end_date
      FROM vc_assignments s
      JOIN vc_assets v ON v.operator_id = s.operator_id AND v.id = s.vc_asset_id
      LEFT JOIN plans p ON p.operator_id = s.operator_id AND p.id = s.plan_id
      WHERE s.operator_id = ${op}::uuid AND s.customer_id = ${customer.id}::uuid
      ORDER BY s.start_date DESC, s.id DESC`);
    const payments = await tx.execute<LastPaymentRow>(sql`
      SELECT p.id, p.amount_paise, p.method, p.business_date::text AS business_date,
        EXISTS (SELECT 1 FROM payment_reversals r
          WHERE r.operator_id = p.operator_id AND r.payment_id = p.id) AS reversed
      FROM payments p
      WHERE p.operator_id = ${op}::uuid AND p.customer_id = ${customer.id}::uuid
      ORDER BY p.posted_at DESC, p.id DESC
      LIMIT 1`);

    const info = extra.rows[0];
    const all = connections.rows.map(
      (row): CustomerConnectionSummary => ({
        assignmentId: row.assignment_id,
        vcAssetId: row.vc_asset_id,
        vcNumber: row.vc_number,
        status: row.status,
        planId: row.plan_id,
        planName: row.plan_name,
        rentalPaise: Number(row.rental_amount_paise),
        startDate: row.start_date,
        endDate: row.end_date,
      }),
    );
    const last = payments.rows[0];
    const profile: CustomerProfile = {
      id: customer.id,
      customerCode: customer.customerCode,
      name: customer.name,
      phone: customer.phone,
      altPhone: customer.altPhone,
      address: customer.address,
      areaId: customer.areaId,
      status: customer.status,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
      areaName: info?.area_name ?? null,
      balancePaise: Number(info?.balance_paise ?? 0),
      creditPaise: Number(info?.credit_paise ?? 0),
      oldestDuePeriod: info?.oldest_due_period ?? null,
      connections: all.filter((c) => c.status !== "disconnected"),
      pastConnections: all.filter((c) => c.status === "disconnected").length,
      lastPayment: last
        ? {
            id: last.id,
            amountPaise: Number(last.amount_paise),
            method: last.method,
            businessDate: last.business_date,
            reversed: Boolean(last.reversed),
          }
        : null,
    };
    return ok(profile);
  },
});

// ---------------------------------------------------------------------------------------------

export const CustomerFormOptionsInput = z.object({}).strict();

export const customerFormOptions = defineService({
  name: "customers.form_options",
  capability: "customers.view",
  input: CustomerFormOptionsInput,
  async run({ ctx, tx }) {
    const areaRows = await tx
      .select({ id: areas.id, name: areas.name, archivedAt: areas.archivedAt })
      .from(areas)
      .where(eq(areas.operatorId, ctx.operatorId))
      .orderBy(sql`lower(${areas.name})`, asc(areas.id));
    const [counter] = await tx
      .select({ next: counters.nextValue })
      .from(counters)
      .where(and(eq(counters.operatorId, ctx.operatorId), eq(counters.name, "customer_code")));
    const value: CustomerFormOptions = {
      areas: areaRows.map((a) => ({ id: a.id, name: a.name, archived: a.archivedAt !== null })),
      nextAutoCode: String(counter?.next ?? 1),
    };
    return ok(value);
  },
});
