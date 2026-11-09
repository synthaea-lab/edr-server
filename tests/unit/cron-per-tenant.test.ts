import { afterEach, describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import { perTenantResponse, runPerTenant, type PerTenantSummary } from "@/lib/cron/per-tenant";

/** A fake db: `locked[tenantId] === false` means another invocation holds that tenant's lock. */
function fakeDb(tenantIds: string[], locked: Record<string, boolean> = {}) {
  const lockCalls: unknown[][] = [];
  const timeouts: unknown[] = [];
  const db = {
    tenant: { findMany: vi.fn(async () => tenantIds.map((id) => ({ id }))) },
    $transaction: vi.fn(async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, opts?: { timeout?: number }) => {
      timeouts.push(opts?.timeout);
      const tx = {
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
          lockCalls.push([strings.join("?"), ...values]);
          return [{ locked: locked[values[1] as string] ?? true }];
        },
      };
      return fn(tx as unknown as Prisma.TransactionClient);
    }),
  };
  return { db: db as unknown as Pick<PrismaClient, "tenant" | "$transaction">, lockCalls, timeouts };
}

afterEach(() => vi.restoreAllMocks());

describe("runPerTenant", () => {
  it("runs the work once per tenant under its own lock and transaction timeout", async () => {
    const { db, lockCalls, timeouts } = fakeDb(["t1", "t2"]);
    const summary = await runPerTenant(db, { lockKey: 42, label: "Test" }, async (_tx, id) => `done:${id}`);

    expect(summary).toEqual({ checked: 2, skipped: 0, failed: 0, results: ["done:t1", "done:t2"] });
    expect(timeouts).toEqual([30_000, 30_000]);
    expect(lockCalls).toHaveLength(2);
    expect(lockCalls[0][0]).toContain("pg_try_advisory_xact_lock(?::int, hashtext(?))");
    expect(lockCalls[0].slice(1)).toEqual([42, "t1"]);
    expect(lockCalls[1].slice(1)).toEqual([42, "t2"]);
  });

  it("passes a custom timeout through", async () => {
    const { db, timeouts } = fakeDb(["t1"]);
    await runPerTenant(db, { lockKey: 1, timeoutMs: 5_000, label: "Test" }, async () => 0);
    expect(timeouts).toEqual([5_000]);
  });

  it("counts a tenant whose lock is held as skipped and does not run its work", async () => {
    const { db } = fakeDb(["t1", "t2"], { t1: false });
    const work = vi.fn(async (_tx: Prisma.TransactionClient, id: string) => id);
    const summary = await runPerTenant(db, { lockKey: 1, label: "Test" }, work);

    expect(summary).toEqual({ checked: 2, skipped: 1, failed: 0, results: ["t2"] });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("counts a throwing tenant as failed, logs it, and continues to the next", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb(["t1", "t2"]);
    const summary = await runPerTenant(db, { lockKey: 1, label: "Test" }, async (_tx, id) => {
      if (id === "t1") throw new Error("boom");
      return id;
    });

    expect(summary).toEqual({ checked: 2, skipped: 0, failed: 1, results: ["t2"] });
    expect(error).toHaveBeenCalledWith("Test error for tenant t1:", expect.any(Error));
  });

  it("counts a transaction that throws synchronously as failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb(["t1"]);
    vi.mocked(db.$transaction).mockImplementationOnce(() => {
      throw new Error("sync");
    });
    const summary = await runPerTenant(db, { lockKey: 1, label: "Test" }, async () => 1);
    expect(summary).toEqual({ checked: 1, skipped: 0, failed: 1, results: [] });
  });
});

describe("perTenantResponse", () => {
  const summary = (checked: number, skipped: number, failed: number): PerTenantSummary<unknown> => ({
    checked,
    skipped,
    failed,
    results: [],
  });

  it("answers 200 with the counters and totals when nothing failed", async () => {
    const res = perTenantResponse("Test", summary(3, 1, 0), { done: 2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantsChecked: 3, tenantsSkipped: 1, tenantsFailed: 0, done: 2 });
  });

  it("answers 200 when there are no tenants at all", async () => {
    const res = perTenantResponse("Test", summary(0, 0, 0), {});
    expect(res.status).toBe(200);
  });

  it("answers 207 when some tenants failed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = perTenantResponse("Test", summary(3, 0, 1), { done: 2 });
    expect(res.status).toBe(207);
    expect(await res.json()).toEqual({
      tenantsChecked: 3,
      tenantsSkipped: 0,
      tenantsFailed: 1,
      done: 2,
      error: "Some tenants failed",
    });
    expect(error).toHaveBeenCalledWith("Test: 1/3 tenants failed");
  });

  it("answers 502 when every tenant failed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = perTenantResponse("Test", summary(2, 0, 2), { done: 0 });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("All tenants failed");
    expect(error).toHaveBeenCalledWith("Test: every tenant failed (2/2)");
  });
});
