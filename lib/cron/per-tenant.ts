import { NextResponse } from "next/server";
import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * The per-tenant sweep the case crons share (group-detections, join-fleet-cases).
 *
 * One transaction **per tenant** (review, Jihair54, a real bug in an earlier batching fix): one
 * shared transaction across every tenant made the timeout budget `tenants × batch size` worth of
 * work, not one batch. With enough tenants it still timed out and rolled back *all* of them,
 * including tenants whose own backlog was tiny, and every later tick redid the same doomed work.
 * Each tenant now gets its own transaction, its own budget and its own advisory lock, so one
 * tenant timing out does not touch any other tenant's progress, this tick or the next.
 *
 * Each tenant's transaction is also caught on its own: without that, one tenant throwing (a real
 * timeout, a serialization failure) would abort the loop and skip every tenant after it in the
 * same invocation, the one-slow-tenant-blocks-everyone failure moved from "every tick" to "the
 * rest of this tick". A failure is counted in `failed` and the loop moves on.
 *
 * The lock is `pg_try_advisory_xact_lock(lockKey, hashtext(tenantId))` (review, Jihair54): two
 * overlapping invocations of a cron (a retry, a duplicated scheduler trigger, a manual run over
 * the schedule) would otherwise read the same tenant's rows and open cases twice. Keying by
 * tenant serializes them per tenant instead of globally, so one invocation's slow tenant does not
 * block another invocation from progressing on a different one. Transaction-scoped, not
 * session-scoped: it is released when the transaction ends, including on a crash, so there is no
 * unlock path to remember. A tenant whose lock is held elsewhere is counted in `skipped`.
 *
 * Each cron passes its own fixed `lockKey`, so different crons never contend with each other.
 */

export interface PerTenantOptions {
  /** The cron's fixed first lock key; the second is a hash of the tenant id. */
  lockKey: number;
  /** Per-tenant transaction timeout. */
  timeoutMs?: number;
  /** Names the cron in log lines: "<label> error for tenant <id>:", "<label>: every tenant failed". */
  label: string;
}

export interface PerTenantSummary<T> {
  /** Tenants listed for this run. */
  checked: number;
  /** Tenants another invocation already held the lock for. */
  skipped: number;
  /** Tenants whose transaction threw. */
  failed: number;
  /** One result per tenant whose work ran and committed. */
  results: T[];
}

export const DEFAULT_TENANT_TIMEOUT_MS = 30_000;

type TenantDb = Pick<PrismaClient, "tenant" | "$transaction">;

const LOCK_HELD = Symbol("lock held elsewhere");

/** Takes this tenant's advisory lock inside `tx`; false when another transaction holds it. */
async function tryTenantLock(tx: Prisma.TransactionClient, lockKey: number, tenantId: string): Promise<boolean> {
  // Explicit ::int cast (review, Jihair54): Prisma binds a plain JS number as bigint, but the
  // two-argument pg_try_advisory_xact_lock only exists as (int4, int4). Without the cast it threw
  // 42883 "function ... does not exist" on every call, so every tenant's transaction failed and
  // nothing ran, masked because the route still answered 200 (see `perTenantResponse`).
  const rows = await tx.$queryRaw<{ locked: boolean }[]>`
    SELECT pg_try_advisory_xact_lock(${lockKey}::int, hashtext(${tenantId})) AS locked
  `;
  return rows[0]?.locked === true;
}

/**
 * Runs `work` once per tenant, each in its own transaction holding that tenant's advisory lock
 * (see the module doc). `work` only runs once the lock is taken.
 */
export async function runPerTenant<T>(
  db: TenantDb,
  { lockKey, timeoutMs = DEFAULT_TENANT_TIMEOUT_MS, label }: PerTenantOptions,
  work: (tx: Prisma.TransactionClient, tenantId: string) => Promise<T>
): Promise<PerTenantSummary<T>> {
  const tenants = await db.tenant.findMany({ select: { id: true } });
  const summary: PerTenantSummary<T> = { checked: tenants.length, skipped: 0, failed: 0, results: [] };

  for (const tenant of tenants) {
    try {
      const result = await db.$transaction(
        async (tx) => ((await tryTenantLock(tx, lockKey, tenant.id)) ? work(tx, tenant.id) : LOCK_HELD),
        { timeout: timeoutMs }
      );
      if (result === LOCK_HELD) {
        summary.skipped++;
      } else {
        summary.results.push(result);
      }
    } catch (error) {
      console.error(`${label} error for tenant ${tenant.id}:`, error);
      summary.failed++;
    }
  }
  return summary;
}

/**
 * The response for a per-tenant run: `{ tenantsChecked, tenantsSkipped, tenantsFailed, ...totals }`.
 *
 * A failure must be visible, not only counted in the body (review, Jihair54): the lock-cast bug
 * made every tenant fail on every tick while the route still answered 200 with zero work done,
 * which no scheduler or monitor would notice. So: 200 when every tenant succeeded or was only
 * skipped; 207 (Multi-Status) when some but not all failed, a partial failure still visible to a
 * caller that checks only for 2xx; 502 when every checked tenant failed, since nothing happened
 * and the caller should treat the run as not having run. Both error statuses add `error`.
 */
export function perTenantResponse<Totals extends object>(
  label: string,
  summary: PerTenantSummary<unknown>,
  totals: Totals
): NextResponse {
  const { checked, skipped, failed } = summary;
  const body = { tenantsChecked: checked, tenantsSkipped: skipped, tenantsFailed: failed, ...totals };
  if (checked > 0 && failed === checked) {
    console.error(`${label}: every tenant failed (${failed}/${checked})`);
    return NextResponse.json({ ...body, error: "All tenants failed" }, { status: 502 });
  }
  if (failed > 0) {
    console.error(`${label}: ${failed}/${checked} tenants failed`);
    return NextResponse.json({ ...body, error: "Some tenants failed" }, { status: 207 });
  }
  return NextResponse.json(body);
}

