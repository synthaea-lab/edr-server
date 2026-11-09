import { Prisma, type PrismaClient } from "@prisma/client";
import {
  HuntValidationError,
  MAX_WINDOW_HOURS,
  checkedList,
  expectVersion,
  lastHoursField,
  queryRecord,
  severitiesField,
  techniquesField,
  textField,
  type Severity,
} from "@/lib/hunt-fields";

export {
  HuntValidationError,
  MAX_TECHNIQUES,
  MAX_TEXT_LENGTH,
  MAX_WINDOW_HOURS,
  MIN_TEXT_LENGTH,
  SEVERITIES,
  type Severity,
} from "@/lib/hunt-fields";

/**
 * Saved hunts (issue #61, ADR-0025).
 *
 * A hunt's `query` is a structured `HuntQuery`, never SQL. It is validated on every
 * write and compiled to parameterized SQL here, scoped to one tenant, so a hunt cannot
 * name a table, a column or another tenant. Slice 1 searches the detection store only;
 * the raw event archive (`server/datalake`) is a later `version` of the query.
 *
 * Client components import this file (the form, `lib/hunt-view.ts`), so it must not reach
 * server-only code: running a hunt and recording its history live in `lib/hunt-runner.ts`,
 * which reaches the notification outbox (`node:crypto`). `tests/unit/client-bundle-imports.test.ts`
 * enforces it (#926).
 */

export const HUNT_QUERY_VERSION = 1;
export const MAX_AGENT_IDS = 50;
/** Newest matching detection ids a run keeps. */
export const HUNT_SAMPLE_SIZE = 100;
/** Runs kept per hunt; older ones are pruned by the cron. */
export const HUNT_RUNS_KEPT = 100;
/** A run that takes longer than this is cancelled by Postgres and recorded as failed. */
export const HUNT_STATEMENT_TIMEOUT_MS = 10_000;
/**
 * How long Prisma keeps the run's interactive transaction open: longer than the statement
 * timeout, so Postgres cancels a slow search itself. Prisma closes an interactive
 * transaction after 5 s by default, which would end a 10 s search with "Transaction already
 * closed" before the statement timeout could fire.
 */
export const HUNT_TRANSACTION_TIMEOUT_MS = HUNT_STATEMENT_TIMEOUT_MS + 2_000;
/** Runs a tenant may start per minute, manual and scheduled together. */
export const MAX_RUNS_PER_TENANT_PER_MINUTE = 20;
/** Shortest schedule (minutes) and longest (a week). */
export const MIN_SCHEDULE_MINUTES = 5;
export const MAX_SCHEDULE_MINUTES = 7 * 24 * 60;

export type HuntQuery = {
  version: typeof HUNT_QUERY_VERSION;
  /** Look back this many hours from the run's start, so a scheduled hunt keeps meaning "recently". */
  lastHours: number;
  /** ATT&CK ids: `T1059` matches `T1059` and every `T1059.xxx`; `T1059.001` only itself. */
  techniques?: string[];
  severities?: Severity[];
  agentIds?: string[];
  /** Case-insensitive substring of the detection's stored event JSON. */
  text?: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates untrusted JSON as a `HuntQuery` and returns it normalized; throws `HuntValidationError`. */
export function parseHuntQuery(input: unknown): HuntQuery {
  const raw = queryRecord(input, ["version", "lastHours", "techniques", "severities", "agentIds", "text"]);
  expectVersion(raw.version, HUNT_QUERY_VERSION);
  const query: HuntQuery = { version: HUNT_QUERY_VERSION, lastHours: lastHoursField(raw.lastHours) };
  if (raw.techniques !== undefined) query.techniques = techniquesField(raw.techniques);
  if (raw.severities !== undefined) query.severities = severitiesField(raw.severities);
  if (raw.agentIds !== undefined) {
    query.agentIds = checkedList(raw.agentIds, "agentIds", MAX_AGENT_IDS, (id) => UUID_RE.test(id), (id) => `"${id}" is not an agent id`);
  }
  if (raw.text !== undefined) query.text = textField(raw.text);
  return query;
}

/** Escapes `\`, `%` and `_` so `text` is matched literally by `ILIKE ... ESCAPE '\'`. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The WHERE conditions of a query, always including the tenant and the window. */
export function huntConditions(tenantId: string, query: HuntQuery, now: Date): Prisma.Sql[] {
  const since = new Date(now.getTime() - query.lastHours * 3_600_000);
  const conditions = [Prisma.sql`tenant_id = ${tenantId}`, Prisma.sql`"timestamp" >= ${since}`];
  if (query.techniques) {
    const clauses = query.techniques.map((t) =>
      t.includes(".")
        ? Prisma.sql`technique = ${t}`
        : Prisma.sql`(technique = ${t} OR technique LIKE ${t + ".%"})`
    );
    conditions.push(Prisma.sql`(${Prisma.join(clauses, " OR ")})`);
  }
  if (query.severities) conditions.push(Prisma.sql`severity IN (${Prisma.join(query.severities)})`);
  if (query.agentIds) conditions.push(Prisma.sql`agent_id IN (${Prisma.join(query.agentIds)})`);
  if (query.text) {
    conditions.push(Prisma.sql`event::text ILIKE ${"%" + escapeLike(query.text) + "%"} ESCAPE '\\'`);
  }
  return conditions;
}

export type HuntResult = { matchCount: number; newMatchCount: number; sample: string[] };

/**
 * Runs `query` for `tenantId` as of `now`. `newSince` (the previous run's start, or null
 * on the first run) bounds what counts as a new match: detections ingested after it.
 * Runs inside a transaction with a statement timeout, so a costly text search is
 * cancelled instead of holding the database.
 */
export async function executeHunt(
  prisma: PrismaClient,
  tenantId: string,
  query: HuntQuery,
  now: Date,
  newSince: Date | null,
  options: ExecuteOptions = {}
): Promise<HuntResult> {
  const where = Prisma.join(huntConditions(tenantId, query, now), " AND ");
  const statementTimeoutMs = options.statementTimeoutMs ?? HUNT_STATEMENT_TIMEOUT_MS;
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
      await options.beforeQuery?.(tx);
      const [{ total, fresh }] = await tx.$queryRaw<{ total: bigint; fresh: bigint }[]>(
        newSince
          ? Prisma.sql`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE created_at > ${newSince}) AS fresh FROM detections WHERE ${where}`
          : Prisma.sql`SELECT COUNT(*) AS total, COUNT(*) AS fresh FROM detections WHERE ${where}`
      );
      const rows = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM detections WHERE ${where} ORDER BY "timestamp" DESC, id LIMIT ${HUNT_SAMPLE_SIZE}`
      );
      return { matchCount: Number(total), newMatchCount: Number(fresh), sample: rows.map((r) => r.id) };
    },
    { timeout: statementTimeoutMs + (HUNT_TRANSACTION_TIMEOUT_MS - HUNT_STATEMENT_TIMEOUT_MS) }
  );
}

/** Test seams: a shorter statement timeout, and SQL to run first (a `pg_sleep` to force a slow search). */
export type ExecuteOptions = {
  statementTimeoutMs?: number;
  beforeQuery?: (tx: Prisma.TransactionClient) => Promise<unknown>;
};

/**
 * What a failed run stores and the API returns. Only messages this module wrote are
 * passed through; anything else (a Prisma or driver error can carry table names and
 * connection details) becomes a generic line and goes to the server log instead.
 */
export function describeRunError(error: unknown): string {
  if (error instanceof HuntValidationError) return error.message;
  const text = error instanceof Error ? error.message : "";
  if (/statement timeout/i.test(text)) return "the search exceeded its time limit and was cancelled";
  return "the run failed (see the server log)";
}
