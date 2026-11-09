import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { loadLakeBacklog } from "@/lib/lake-backlog";

const NOW = new Date(Date.UTC(2026, 10, 9, 12, 0, 0));

function prismaWith(agg: { count: number; sum: number | null; min: Date | null }) {
  const aggregate = vi.fn().mockResolvedValue({
    _count: { _all: agg.count },
    _sum: { eventCount: agg.sum },
    _min: { receivedAt: agg.min },
  });
  return { prisma: { lakeBatch: { aggregate } } as unknown as PrismaClient, aggregate };
}

describe("loadLakeBacklog", () => {
  it("counts the tenant's queued batches and ages the oldest", async () => {
    const { prisma, aggregate } = prismaWith({ count: 3, sum: 250, min: new Date(NOW.getTime() - 90_000) });

    expect(await loadLakeBacklog(prisma, "t1", NOW)).toEqual({ batches: 3, events: 250, oldestAgeMs: 90_000 });
    expect(aggregate).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1" } }));
  });

  it("reports an empty queue with no age", async () => {
    const { prisma } = prismaWith({ count: 0, sum: null, min: null });

    expect(await loadLakeBacklog(prisma, "t1", NOW)).toEqual({ batches: 0, events: 0, oldestAgeMs: null });
  });

  it("never reports a negative age when the clock was set back", async () => {
    const { prisma } = prismaWith({ count: 1, sum: 10, min: new Date(NOW.getTime() + 5000) });

    expect((await loadLakeBacklog(prisma, "t1", NOW)).oldestAgeMs).toBe(0);
  });
});
