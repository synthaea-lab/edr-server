import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestAgent, createTestTenant, prisma } from "../helpers/db";
import { loadLakeBacklog } from "@/lib/lake-backlog";
import { enqueueLakeBatch } from "@/lib/lake-writer";

const NOW = new Date(Date.UTC(2026, 10, 9, 12, 0, 0));
const ev = (n: number) => ({ type: "exec", meta: { timestamp_ns: (NOW.getTime() + n) * 1_000_000 }, image_path: `/bin/${n}` });

describe("lake backlog against Postgres", () => {
  beforeEach(cleanDatabase);

  it("counts only the asking tenant's queue", async () => {
    const a = await createTestTenant();
    const b = await createTestTenant();
    const agentA = await createTestAgent(a.id);
    const agentB = await createTestAgent(b.id);
    await enqueueLakeBatch(prisma, { tenantId: a.id, agentId: agentA.id, events: [ev(1), ev(2)], receivedAt: new Date(NOW.getTime() - 600_000) });
    await enqueueLakeBatch(prisma, { tenantId: a.id, agentId: agentA.id, events: [ev(3)], receivedAt: new Date(NOW.getTime() - 60_000) });
    await enqueueLakeBatch(prisma, { tenantId: b.id, agentId: agentB.id, events: [ev(4)], receivedAt: new Date(NOW.getTime() - 5_000) });

    expect(await loadLakeBacklog(prisma, a.id, NOW)).toEqual({ batches: 2, events: 3, oldestAgeMs: 600_000 });
    expect(await loadLakeBacklog(prisma, b.id, NOW)).toEqual({ batches: 1, events: 1, oldestAgeMs: 5_000 });
  });

  it("is empty for a tenant with nothing queued", async () => {
    const t = await createTestTenant();

    expect(await loadLakeBacklog(prisma, t.id, NOW)).toEqual({ batches: 0, events: 0, oldestAgeMs: null });
  });
});
