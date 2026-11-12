import type { PrismaClient } from "@prisma/client";

/**
 * The telemetry archive's write queue for one tenant (issue #4, ADR-0041): batches the ingest
 * route accepted that `write-lake` has not written yet. The agent's `2xx` means "durably queued",
 * not "in the lake" (ADR-0041, decision 3), so the age of the oldest queued batch is the lag a
 * stuck writer or a down object store shows as. Nothing bounds the queue; this makes its growth
 * visible and decides nothing about what to do at a bound.
 */
export type LakeBacklog = {
  batches: number;
  events: number;
  /** Age of the oldest queued batch in ms; `null` when the queue holds none for this tenant. */
  oldestAgeMs: number | null;
};

export async function loadLakeBacklog(prisma: PrismaClient, tenantId: string, now: Date): Promise<LakeBacklog> {
  const agg = await prisma.lakeBatch.aggregate({
    where: { tenantId },
    _count: { _all: true },
    _sum: { eventCount: true },
    _min: { receivedAt: true },
  });
  const oldest = agg._min.receivedAt;
  return {
    batches: agg._count._all,
    events: agg._sum.eventCount ?? 0,
    // A clock set back can put the oldest batch in the future: never show a negative age.
    oldestAgeMs: oldest ? Math.max(0, now.getTime() - oldest.getTime()) : null,
  };
}
