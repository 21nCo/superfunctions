/**
 * Temporal range push-down: period/range clauses are lowered to field bounds
 * the database applies, with results identical to in-memory evaluation of the
 * original clause.
 *
 * Each case runs the query through the server (memory adapter) and compares
 * the response with `executeQuery` over every stored row, which is the
 * in-memory evaluator the server used for all temporal queries before.
 */

import { describe, expect, it, vi } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import {
  TIMEZONE_CHANGE_RESOURCE_NAME,
  resolveTemporalPeriodRange,
  time,
  type DatafnSchema,
  type DatafnTemporalClause,
} from "@datafn/core";
import { createDatafnServer } from "../src/server.js";
import { executeQuery } from "../src/execution/query/execute.js";
import { MemoryStore } from "../src/execution/memory-store.js";
import { extractPushableFilters } from "../src/execution/query/planner.js";
import { lowerTemporalRanges } from "../src/execution/query/temporal-pushdown.js";

const NS = "datafn";
const DAY = 86_400_000;

const SCHEMA: DatafnSchema = {
  resources: [
    {
      name: "session",
      version: 1,
      capabilities: ["timestamps"] as any,
      fields: [
        { name: "startUnix", type: "number", required: false, nullable: true },
        { name: "startSec", type: "number", required: false, nullable: true },
        { name: "minutes", type: "number", required: true },
        { name: "kind", type: "string", required: true },
        { name: "startIso", type: "string", required: false, nullable: true },
        { name: "dueAt", type: "date", required: false, nullable: true },
        { name: "previousId", type: "string", required: false, nullable: true },
      ],
    },
  ],
  relations: [
    { from: "session", to: "session", type: "many-one", relation: "previous", inverse: "following", fkField: "previousId" },
  ] as any,
};

const TIMEZONES = ["UTC", "America/New_York", "Asia/Kolkata", "Australia/Lord_Howe"];

/** The user's timezone history: New York, then Kolkata from 2026-06-01. */
const TIMEZONE_CHANGES = [
  {
    id: "timezoneChange:1:America_New_York",
    timezone: "America/New_York",
    effectiveFrom: Date.parse("2025-01-01T00:00:00.000Z"),
    recordedAt: Date.parse("2025-01-01T00:00:00.000Z"),
  },
  {
    id: "timezoneChange:2:Asia_Kolkata",
    timezone: "Asia/Kolkata",
    effectiveFrom: Date.parse("2026-06-01T00:00:00.000Z"),
    recordedAt: Date.parse("2026-06-01T00:00:00.000Z"),
  },
];

const ANCHORS = [
  "2026-03-08T07:30:00.000Z", // US DST start
  "2026-05-18T12:00:00.000Z",
  "2026-06-01T00:00:00.000Z", // timezone change
  "2026-10-04T15:45:00.000Z",
  "2026-12-31T23:30:00.000Z",
];

/** Instants dense around every period boundary the cases use, plus a spread. */
function seedInstants(): number[] {
  const instants = new Set<number>();
  const start = Date.parse("2025-11-01T00:00:00.000Z");
  for (let t = start; t < Date.parse("2027-02-01T00:00:00.000Z"); t += 3 * 3_600_000 + 17 * 60_000) {
    instants.add(t);
  }
  const timezones = [...TIMEZONES, ...TIMEZONE_CHANGES.map((change) => change.timezone)];
  for (const anchor of ANCHORS) {
    for (const scale of ["hour", "day", "week", "month", "quarter", "year"] as const) {
      for (const timezone of timezones) {
        for (const weekStartsOn of [0, 1, 6]) {
          const { start: s, end: e } = resolveTemporalPeriodRange({ scale, at: anchor }, timezone, weekStartsOn);
          for (const t of [s - 1000, s - 1, s, s + 1, e - 1, e, e + 1, e + 1000]) instants.add(t);
        }
      }
    }
  }
  return [...instants].sort((a, b) => a - b);
}

async function createFixture(options: { searchIds?: () => string[] } = {}) {
  const db = memoryAdapter();
  await db.initialize();
  const rows: Record<string, unknown>[] = [];
  seedInstants().forEach((t, i) => {
    rows.push({
      id: `session:${String(i).padStart(5, "0")}`,
      startUnix: i % 97 === 0 ? null : t,
      startSec: i % 89 === 0 ? null : Math.floor(t / 1000) + (i % 3 === 0 ? 0.5 : 0),
      minutes: (i % 50) + 1,
      kind: i % 3 === 0 ? "focus" : "break",
      startIso: new Date(t).toISOString(),
      dueAt: i % 2 === 0 ? t : new Date(t).toISOString(),
      previousId: i > 0 ? `session:${String(i - 1).padStart(5, "0")}` : null,
      createdAt: t + 7,
      updatedAt: t + 7,
    });
  });
  for (const row of rows) await db.create({ model: "session", data: row, namespace: NS });
  for (const change of TIMEZONE_CHANGES) {
    await db.create({ model: TIMEZONE_CHANGE_RESOURCE_NAME, data: change, namespace: NS });
  }
  const server = await createDatafnServer({
    allowUnknownResources: true,
    schema: SCHEMA,
    limits: { maxLimit: 100_000 },
    database: db,
    ...(options.searchIds
      ? {
          searchProvider: {
            name: "test-search",
            search: async () => options.searchIds!(),
            updateIndices: async () => {},
          } as any,
        }
      : {}),
  });
  return { db, server, rowCount: rows.length, ids: rows.map((row) => row.id as string) };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

/** In-memory evaluation of the original query over every stored row. */
async function inMemory(fx: Fixture, query: Record<string, unknown>) {
  const records: Record<string, Record<string, unknown>> = {};
  for (const row of await fx.db.findMany({ model: "session", where: [], namespace: NS })) {
    records[row.id as string] = row as Record<string, unknown>;
  }
  const changes: Record<string, Record<string, unknown>> = {};
  for (const row of await fx.db.findMany({ model: TIMEZONE_CHANGE_RESOURCE_NAME, where: [], namespace: NS })) {
    changes[row.id as string] = row as Record<string, unknown>;
  }
  const store = new MemoryStore({ records: { session: records, [TIMEZONE_CHANGE_RESOURCE_NAME]: changes }, joins: {} });
  return JSON.parse(JSON.stringify(executeQuery(structuredClone(query) as any, fx.server.schema, store)));
}

/** Runs the query through the server and reports the session rows the database returned. */
async function served(fx: Fixture, query: Record<string, unknown>) {
  const spy = vi.spyOn(fx.db, "findMany");
  try {
    const res = await fx.server.router.handle(
      new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(query),
      }),
      {},
    );
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);
    let rowsRead = 0;
    const calls: Array<{ where?: unknown[] }> = [];
    for (let i = 0; i < spy.mock.calls.length; i++) {
      const params = spy.mock.calls[i][0];
      if (params.model !== "session") continue;
      calls.push(params as { where?: unknown[] });
      rowsRead += ((await spy.mock.results[i].value) as unknown[]).length;
    }
    return { result: body.result, rowsRead, calls };
  } finally {
    spy.mockRestore();
  }
}

async function expectParity(fx: Fixture, query: Record<string, unknown>) {
  const expected = await inMemory(fx, query);
  const actual = await served(fx, query);
  expect(actual.result).toEqual(expected);
  return { ...actual, expected };
}

function q(temporal: DatafnTemporalClause | DatafnTemporalClause[], extra: Record<string, unknown> = {}) {
  return {
    resource: "session",
    version: 1,
    select: ["id", "startUnix", "minutes"],
    sort: ["id:asc"],
    temporal,
    ...extra,
  };
}

describe("temporal range push-down", () => {
  it("matches in-memory results for every period scale, timezone and weekStartsOn, reading only rows in range", async () => {
    const fx = await createFixture();
    let cases = 0;
    for (const at of ANCHORS) {
      for (const scale of ["hour", "day", "week", "month", "quarter", "year"] as const) {
        for (const timezone of [...TIMEZONES, "user"]) {
          const weekStarts = scale === "week" ? [0, 1, 6] : [undefined];
          for (const weekStartsOn of weekStarts) {
            const clause = time.period("startUnix", { scale, at }, {
              timezone,
              ...(weekStartsOn === undefined ? {} : { weekStartsOn }),
            });
            const query = q(clause);
            const { result, rowsRead, calls } = await expectParity(fx, query);
            // Only the rows in range left the database.
            expect(rowsRead).toBe(result.data.length);
            expect(calls[0].where).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ field: "startUnix", operator: "gte" }),
                expect.objectContaining({ field: "startUnix", operator: "lte" }),
              ]),
            );
            expect(result.data.length).toBeGreaterThan(0);
            cases++;
          }
        }
      }
    }
    expect(cases).toBe(ANCHORS.length * (5 * 5 + 3 * 5));
  }, 120_000);

  it("resolves timezone \"user\" from the timezone-change history in effect at the period", async () => {
    const fx = await createFixture();
    // Before 2026-06-01 the user is in New York; after it, in Kolkata.
    for (const [at, timezone] of [
      ["2026-05-18T12:00:00.000Z", "America/New_York"],
      ["2026-10-04T15:45:00.000Z", "Asia/Kolkata"],
    ] as const) {
      const user = await served(fx, q(time.day("startUnix", at, { timezone: "user" })));
      const explicit = await served(fx, q(time.day("startUnix", at, { timezone })));
      expect(user.result).toEqual(explicit.result);
      const { start, end } = resolveTemporalPeriodRange({ scale: "day", at }, timezone);
      expect(user.result.data.every((row: any) => row.startUnix >= start && row.startUnix <= end)).toBe(true);
    }
  });

  it("matches in-memory results for range clauses", async () => {
    const fx = await createFixture();
    const ranges: Array<[string | number, string | number]> = [
      ["2026-05-01T00:00:00.000Z", "2026-05-31T23:59:59.999Z"],
      [Date.parse("2026-03-08T00:00:00.000Z"), Date.parse("2026-03-09T12:00:00.000Z")],
      ["2026-12-31T22:00:00.000Z", "2027-01-01T02:00:00.000Z"],
      [String(Date.parse("2026-06-01T00:00:00.000Z")), String(Date.parse("2026-06-02T00:00:00.000Z"))],
      ["2026-07-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"], // empty: start after end
    ];
    for (const [start, end] of ranges) {
      const { result, rowsRead } = await expectParity(fx, q(time.range("startUnix", { start, end })));
      expect(rowsRead).toBe(result.data.length);
    }
  });

  it("matches in-memory results for unix-s storage, including fractional seconds", async () => {
    const fx = await createFixture();
    for (const at of ANCHORS) {
      for (const scale of ["hour", "day", "week", "month"] as const) {
        for (const timezone of ["UTC", "Asia/Kolkata", "user"]) {
          const query = {
            ...q(time.period("startSec", { scale, at }, { timezone, storage: "unix-s" })),
            select: ["id", "startSec"],
          };
          const { result, rowsRead } = await expectParity(fx, query);
          expect(rowsRead).toBe(result.data.length);
        }
      }
      const range = {
        ...q(time.range("startSec", {
          start: Math.floor(Date.parse(at) / 1000) - 3600,
          end: Math.floor(Date.parse(at) / 1000) + 3600,
        }, { storage: "unix-s" })),
        select: ["id", "startSec"],
      };
      const { result, rowsRead } = await expectParity(fx, range);
      expect(rowsRead).toBe(result.data.length);
    }
  }, 120_000);

  it("pushes capability timestamp periods (createdAt)", async () => {
    const fx = await createFixture();
    for (const at of ANCHORS) {
      const query = { ...q(time.month("createdAt", at, { timezone: "user" })), select: ["id", "createdAt"] };
      const { result, rowsRead } = await expectParity(fx, query);
      expect(rowsRead).toBe(result.data.length);
      expect(result.data.length).toBeGreaterThan(0);
    }
  });

  it("groups and aggregates over the range-prefiltered rows", async () => {
    const fx = await createFixture();
    for (const at of ANCHORS) {
      for (const timezone of ["UTC", "America/New_York", "user"]) {
        const separate = {
          resource: "session",
          version: 1,
          temporal: [
            time.month("startUnix", at, { timezone }),
            time.groupByDay("startUnix", { alias: "day", timezone }),
          ],
          aggregations: { total: { op: "sum", field: "minutes" }, sessions: { op: "count", field: "id" } },
        };
        const a = await expectParity(fx, separate);
        expect(a.result.groups.length).toBeGreaterThan(0);
        const monthRows = (await served(fx, q(time.month("startUnix", at, { timezone })))).result.data.length;
        expect(a.rowsRead).toBe(monthRows);

        // One clause with both a period and a grouping.
        const combined = {
          resource: "session",
          version: 1,
          temporal: { ...time.groupByDay("startUnix", { alias: "day", timezone }), period: { scale: "week", at }, weekStartsOn: 0 },
          groupBy: ["kind"],
          aggregations: { total: { op: "sum", field: "minutes" } },
          sort: ["day:asc", "kind:asc"],
        };
        const b = await expectParity(fx, combined);
        expect(b.result.groups.length).toBeGreaterThan(0);
        const weekRows = (await served(fx, q(time.week("startUnix", at, { timezone, weekStartsOn: 0 })))).result.data.length;
        expect(b.rowsRead).toBe(weekRows);
      }
    }
  }, 120_000);

  it("combines with filters, sort, limit, count and cursors", async () => {
    const fx = await createFixture();
    const temporal = time.month("startUnix", "2026-05-18T12:00:00.000Z", { timezone: "user" });
    const base = { ...q(temporal), select: ["id", "startUnix", "minutes", "kind"] };
    await expectParity(fx, { ...base, filters: { kind: "focus", minutes: { $gte: 10 } } });
    await expectParity(fx, { ...base, filters: { $and: [{ kind: { $in: ["focus", "break"] } }, { minutes: { $lt: 20 } }] } });
    const page = await expectParity(fx, { ...base, sort: ["minutes:desc", "id:asc"], limit: 7, count: true });
    expect(page.result.data).toHaveLength(7);
    await expectParity(fx, {
      ...base,
      sort: ["minutes:desc", "id:asc"],
      limit: 7,
      cursor: { after: page.result.nextCursor },
    });
    await expectParity(fx, {
      ...base,
      sort: ["minutes:desc", "id:asc"],
      limit: 5,
      cursor: { before: page.result.nextCursor },
    });
    // Two temporal clauses on different fields.
    await expectParity(fx, q([temporal, time.year("createdAt", "2026-05-18T12:00:00.000Z")]));
  });

  it("keeps clauses the database cannot compare identically in memory", async () => {
    const fx = await createFixture();
    const at = "2026-05-18T12:00:00.000Z";
    // ISO storage on a string field and a user-declared date field (mixed ISO
    // strings and numbers) are evaluated in memory over the whole table.
    for (const clause of [
      time.day("startIso", at, { storage: "iso" }),
      time.day("dueAt", at),
      time.range("startUnix", { start: -DAY, end: DAY }), // contains 0: in memory, null matches
    ]) {
      const { result, rowsRead } = await expectParity(fx, { ...q(clause), select: ["id"] });
      expect(rowsRead).toBe(fx.rowCount);
      if (clause.field !== "startUnix") expect(result.data.length).toBeGreaterThan(0);
    }
    // A query mixing a lowerable and an in-memory clause pushes the former.
    const mixed = await expectParity(fx, {
      ...q([time.month("startUnix", at), time.day("startIso", at, { storage: "iso" })]),
      select: ["id"],
    });
    const monthRows = (await served(fx, q(time.month("startUnix", at)))).result.data.length;
    expect(mixed.rowsRead).toBe(monthRows);
    expect(mixed.result.data.length).toBeGreaterThan(0);
  });
});

describe("temporal queries through self relations", () => {
  it("keeps loading every row when a relation path leads back to the queried resource", async () => {
    const fx = await createFixture();
    const at = "2026-05-18T12:00:00.000Z";
    for (const query of [
      { ...q(time.day("startUnix", at)), select: ["id", "previous.*"] },
      { ...q(time.day("startUnix", at)), select: ["id", "following.*"] },
      { ...q(time.day("startUnix", at)), select: ["id"], filters: { "previous.kind": "focus" } },
      { ...q(time.day("startUnix", at)), select: ["id"], filters: { previous: { $any: { kind: "focus" } } } },
    ]) {
      const { result, rowsRead } = await expectParity(fx, query);
      expect(result.data.length).toBeGreaterThan(0);
      expect(rowsRead).toBe(fx.rowCount);
    }
    // The first in-range row's previous row is outside the range and still resolves.
    const { result } = await served(fx, { ...q(time.day("startUnix", at)), select: ["id", "startUnix", "previous.*"] });
    const { start } = resolveTemporalPeriodRange({ scale: "day", at });
    expect(result.data[0].previous.startUnix).toBeLessThan(start);
  });
});

describe("temporal search queries", () => {
  it("resolves timezone \"user\" the same way for lowered bounds and in-memory clauses", async () => {
    let fx!: Fixture;
    fx = await createFixture({ searchIds: () => fx.ids });
    const at = "2026-05-18T12:00:00.000Z";
    const search = { query: "anything", type: "fullText" };
    const viaSearch = await served(fx, {
      ...q([time.week("startUnix", at, { timezone: "user" }), time.day("startIso", at, { timezone: "user", storage: "iso" })]),
      search,
      select: ["id"],
    });
    const plain = await expectParity(fx, {
      ...q([time.week("startUnix", at, { timezone: "user" }), time.day("startIso", at, { timezone: "user", storage: "iso" })]),
      select: ["id"],
    });
    expect(plain.result.data.length).toBeGreaterThan(0);
    expect(viaSearch.result.data).toEqual(plain.result.data);
    expect(viaSearch.rowsRead).toBeLessThan(fx.rowCount);
  });
});

describe("lowerTemporalRanges", () => {
  const config = {};
  it("lowers a period to the in-memory bounds and leaves a pushable query", () => {
    const query = q(time.day("startUnix", "2026-05-18T12:00:00.000Z", { timezone: "Asia/Kolkata" }), {
      filters: { kind: "focus" },
    });
    const { query: lowered, lowered: fields } = lowerTemporalRanges(query, SCHEMA, config);
    const { start, end } = resolveTemporalPeriodRange(
      { scale: "day", at: "2026-05-18T12:00:00.000Z" },
      "Asia/Kolkata",
    );
    expect(fields).toEqual(["startUnix"]);
    expect(lowered.temporal).toBeUndefined();
    expect(lowered.filters).toEqual({ kind: "focus", $and: [{ startUnix: { $gte: start, $lte: end } }] });
  });

  it("keeps existing filters at the top level so the pre-filter still pushes them key by key", () => {
    const query = q(time.day("startUnix", "2026-05-18T12:00:00.000Z"), {
      filters: { kind: "focus", minutes: { $between: [1, 9] }, $and: [{ minutes: { $gte: 3 } }] },
    });
    const { query: lowered } = lowerTemporalRanges(query, SCHEMA, config);
    const { start, end } = resolveTemporalPeriodRange({ scale: "day", at: "2026-05-18T12:00:00.000Z" });
    expect(lowered.filters).toEqual({
      kind: "focus",
      minutes: { $between: [1, 9] },
      $and: [{ minutes: { $gte: 3 } }, { startUnix: { $gte: start, $lte: end } }],
    });
    // `$between` is not pushable; the keys next to it still are.
    const { pushable } = extractPushableFilters(lowered.filters as Record<string, unknown>, "session", SCHEMA);
    expect(pushable).toEqual(
      expect.arrayContaining([
        { field: "kind", operator: "eq", value: "focus" },
        { field: "minutes", operator: "gte", value: 3 },
        { field: "startUnix", operator: "gte", value: start },
        { field: "startUnix", operator: "lte", value: end },
      ]),
    );
  });

  it("resolves an omitted `at` once for lowered and retained clauses", () => {
    const now = Date.parse("2026-05-18T23:59:59.999Z");
    const spy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const { query: lowered } = lowerTemporalRanges(
        q([time.day("startUnix"), { field: "startIso", storage: "iso", period: { scale: "day", at: null as any } }]),
        SCHEMA,
        config,
      );
      const { start, end } = resolveTemporalPeriodRange({ scale: "day", at: now });
      expect(lowered.filters).toEqual({ startUnix: { $gte: start, $lte: end } });
      expect(lowered.temporal).toEqual(
        expect.objectContaining({ field: "startIso", period: { scale: "day", at: new Date(now).toISOString() } }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("does not lower when a relation path leads back to the queried resource", () => {
    const query = { ...q(time.day("startUnix", "2026-05-18T12:00:00.000Z")), select: ["id", "previous.*"] };
    expect(lowerTemporalRanges(query, SCHEMA, config).query).toBe(query);
  });

  it("does not lower when the query reads any relation", () => {
    const schema = {
      resources: [
        ...SCHEMA.resources,
        {
          name: "project",
          version: 1,
          fields: [
            { name: "label", type: "string", required: true },
            { name: "previousId", type: "string", required: false, nullable: true },
          ],
        },
      ],
      relations: [
        { from: "session", to: "project", type: "many-one", relation: "project", inverse: "sessions", fkField: "projectId" },
        { from: "project", to: "project", type: "many-one", relation: "previous", inverse: "next", fkField: "previousId" },
      ],
    } as unknown as DatafnSchema;
    const temporal = time.day("startUnix", "2026-05-18T12:00:00.000Z");
    for (const query of [
      { ...q(temporal), filters: { project: { $any: { previous: { $any: { label: "x" } } } } } },
      { ...q(temporal), filters: { "project.previous.label": "x" } },
      { resource: "session", version: 1, temporal, groupBy: ["project.previous.label"], aggregations: { n: { op: "count", field: "id" } } },
      { ...q(temporal), select: ["id", "project.previous.*"] },
    ]) {
      expect(lowerTemporalRanges(query, schema, config).query).toBe(query);
    }
    // Any relation read keeps the full load; plain field reads are lowered.
    const withRelation = { ...q(temporal), select: ["id", "project.*"] };
    expect(lowerTemporalRanges(withRelation, schema, config).query).toBe(withRelation);
    expect(lowerTemporalRanges({ ...q(temporal), select: ["id", "projectId"] }, schema, config).lowered).toEqual(["startUnix"]);
  });

  it("keeps only the grouping of a clause whose period was lowered", () => {
    const clause = { ...time.groupByDay("startUnix", { alias: "day" }), period: { scale: "week" as const } };
    const { query: lowered } = lowerTemporalRanges(q(clause), SCHEMA, config);
    expect(lowered.temporal).toEqual({ field: "startUnix", groupBy: { scale: "day", alias: "day", output: undefined } });
  });

  it("leaves non-numeric storage, non-number fields and invalid bounds untouched", () => {
    for (const clause of [
      time.day("startIso", "2026-05-18T12:00:00.000Z", { storage: "iso" }),
      time.day("dueAt", "2026-05-18T12:00:00.000Z"),
      time.day("startUnix", "not a date"),
      time.day("unknownField", "2026-05-18T12:00:00.000Z"),
    ]) {
      const query = q(clause);
      expect(lowerTemporalRanges(query, SCHEMA, config).query).toBe(query);
    }
  });
});
