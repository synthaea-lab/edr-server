import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { cleanDatabase, createTestAgent, createTestTenant, prisma } from "../helpers/db";
import { FsLakeStore, type DeleteResult, type LakeStore } from "@/lib/lake-store";
import { drainLakeQueue, enqueueLakeBatch } from "@/lib/lake-writer";
import { compactLake, compactedKey } from "@/lib/lake-compaction";
import { queryLake } from "@/lib/lake-query";
import { pruneLake } from "@/lib/lake-retention";
import { GET as compactRoute } from "@/app/api/cron/compact-lake/route";

const DAY = 86_400_000;
const NOW = new Date(Date.UTC(2026, 10, 9, 12, 0, 0));
const FEW = { minFiles: 3 };

let dir: string;
let store: FsLakeStore;
const io = () => ({ store, reader: store });

beforeEach(async () => {
  await cleanDatabase();
  await prisma.lakeCompaction.deleteMany();
  await prisma.lakeDeletion.deleteMany();
  dir = await mkdtemp(path.join(os.tmpdir(), "lake-compact-"));
  store = new FsLakeStore(dir);
  process.env.CRON_SECRET = "test_cron_secret";
});

afterEach(async () => {
  delete process.env.LAKE_DIR;
  await rm(dir, { recursive: true, force: true });
});

afterAll(async () => {
  await prisma.lakeCompaction.deleteMany();
  await prisma.lakeDeletion.deleteMany();
  await cleanDatabase();
  await prisma.$disconnect();
});

const ev = (at: Date, over: Record<string, unknown> = {}) => ({ type: "exec", meta: { comm: "bash", timestamp_ns: at.getTime() * 1_000_000 }, image_path: "/usr/bin/curl", ...over });

/** One flush (one small file) of `count` events dated `daysAgo` days before NOW, drained the day they happened. */
async function flush(tenantId: string, agentId: string, daysAgo: number, tag: string, count = 2, at0 = NOW.getTime() - daysAgo * DAY - 3600_000) {
  const at = new Date(at0);
  await enqueueLakeBatch(prisma, { tenantId, agentId, events: Array.from({ length: count }, (_, i) => ev(new Date(at.getTime() + i), { image_path: `/p/${tag}/${i}` })), receivedAt: at });
  await drainLakeQueue(prisma, store, { now: at });
}

async function files(prefix = "") {
  return (await store.list(prefix)).map((f) => f.key).sort();
}

async function setup(retention = 90) {
  const tenant = await createTestTenant();
  const agent = await createTestAgent(tenant.id);
  await prisma.tenant.update({ where: { id: tenant.id }, data: { lakeRetentionDays: retention } });
  return { tenant, agent };
}

const rowsOf = async (tenantId: string, from: string, to: string) =>
  (await queryLake(store, { tenantId, from, to, limit: 1000 })).rows.map((r) => r.event).sort();

describe("lake compaction against Postgres", () => {
  it("merges the small files of a closed day into one and loses no row", async () => {
    const { tenant, agent } = await setup();
    for (let i = 0; i < 4; i++) await flush(tenant.id, agent.id, 2, `f${i}`);
    expect(await files(`tenant=${tenant.id}/`)).toHaveLength(4);
    const before = await rowsOf(tenant.id, "2026-11-01", "2026-11-09");
    expect(before).toHaveLength(8);

    const result = await compactLake(prisma, io(), NOW, FEW);

    expect(result).toMatchObject({ partitionsCompacted: 1, filesMerged: 4, failedPartitions: 0, finished: 0, abandoned: 0 });
    const after = await files(`tenant=${tenant.id}/`);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatch(/\/c-[0-9a-f]{32}\.parquet$/);
    expect(await rowsOf(tenant.id, "2026-11-01", "2026-11-09")).toEqual(before);
    const record = await prisma.lakeCompaction.findFirstOrThrow();
    expect(record).toMatchObject({ tenantId: tenant.id, finishedHow: "compacted", rowCount: 8, deletedCount: 4 });
    expect(record.completedAt).not.toBeNull();
  });

  it("keeps the event text byte for byte, integers above 2^53 included", async () => {
    const { tenant, agent } = await setup();
    const at = new Date(NOW.getTime() - 2 * DAY);
    const text = `{"type":"exec","meta":{"timestamp_ns":${at.getTime()}000000,"generation":18446744073709551615},"image_path":"/big"}`;
    for (let i = 0; i < 3; i++) {
      await enqueueLakeBatch(prisma, { tenantId: tenant.id, agentId: agent.id, events: [text], receivedAt: at });
      await drainLakeQueue(prisma, store, { now: at });
    }

    await compactLake(prisma, io(), NOW, FEW);

    const rows = (await queryLake(store, { tenantId: tenant.id, from: "2026-11-01", to: "2026-11-09" })).rows;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.event === text)).toBe(true);
  });

  it("leaves alone today's partition, a partition below the file threshold, and one about to be pruned", async () => {
    const { tenant, agent } = await setup(30);
    for (let i = 0; i < 4; i++) await flush(tenant.id, agent.id, 0, `today${i}`, 1, NOW.getTime() - 60_000 - i);
    for (let i = 0; i < 2; i++) await flush(tenant.id, agent.id, 3, `few${i}`);
    for (let i = 0; i < 4; i++) await flush(tenant.id, agent.id, 29, `edge${i}`);
    const before = await files(`tenant=${tenant.id}/`);

    const result = await compactLake(prisma, io(), NOW, FEW);

    expect(result.partitionsCompacted).toBe(0);
    expect(await files(`tenant=${tenant.id}/`)).toEqual(before);
    expect(await prisma.lakeCompaction.count()).toBe(0);
  });

  it("does not compact a tenant that keeps nothing, nor touch another tenant's files", async () => {
    const a = await setup();
    const b = await setup();
    for (let i = 0; i < 3; i++) await flush(a.tenant.id, a.agent.id, 2, `a${i}`);
    for (let i = 0; i < 2; i++) await flush(b.tenant.id, b.agent.id, 2, `b${i}`);
    const bBefore = await files(`tenant=${b.tenant.id}/`);

    await compactLake(prisma, io(), NOW, FEW);

    expect(await files(`tenant=${a.tenant.id}/`)).toHaveLength(1);
    expect(await files(`tenant=${b.tenant.id}/`)).toEqual(bBefore);
  });

  it("is idempotent, and merges a late file with the compacted one", async () => {
    const { tenant, agent } = await setup();
    for (let i = 0; i < 3; i++) await flush(tenant.id, agent.id, 2, `f${i}`);
    await compactLake(prisma, io(), NOW, FEW);
    const merged = await files(`tenant=${tenant.id}/`);
    expect((await compactLake(prisma, io(), NOW, FEW)).partitionsCompacted).toBe(0);
    expect(await files(`tenant=${tenant.id}/`)).toEqual(merged);

    // An event with a past timestamp, still inside retention, flushed days later.
    for (let i = 0; i < 2; i++) await flush(tenant.id, agent.id, 2, `late${i}`, 1, NOW.getTime() - 2 * DAY - 7200_000 - i);
    expect(await files(`tenant=${tenant.id}/`)).toHaveLength(3);
    const result = await compactLake(prisma, io(), NOW, { minFiles: 2 });

    expect(result).toMatchObject({ partitionsCompacted: 1, filesMerged: 3 });
    expect(await rowsOf(tenant.id, "2026-11-01", "2026-11-09")).toHaveLength(6 + 2);
  });

  it("finishes a merge that crashed after the merged file was written: no row twice, inputs gone", async () => {
    const { tenant, agent } = await setup();
    for (let i = 0; i < 4; i++) await flush(tenant.id, agent.id, 2, `f${i}`);
    const before = await rowsOf(tenant.id, "2026-11-01", "2026-11-09");
    const failingDelete: LakeStore = {
      put: (k, b) => store.put(k, b),
      list: (p) => store.list(p),
      delete: async (): Promise<DeleteResult> => {
        throw new Error("store went away");
      },
    };

    const first = await compactLake(prisma, { store: failingDelete, reader: store }, NOW, FEW);

    expect(first.failedPartitions).toBe(1);
    expect(await files(`tenant=${tenant.id}/`)).toHaveLength(5); // merged + 4 inputs: a reader would see rows twice
    expect((await prisma.lakeCompaction.findFirstOrThrow()).completedAt).toBeNull();

    const second = await compactLake(prisma, io(), NOW, FEW);

    expect(second).toMatchObject({ finished: 1, failedPartitions: 0 });
    expect(await files(`tenant=${tenant.id}/`)).toHaveLength(1);
    expect(await rowsOf(tenant.id, "2026-11-01", "2026-11-09")).toEqual(before);
    expect((await prisma.lakeCompaction.findFirstOrThrow()).finishedHow).toBe("compacted");
  });

  it("gives up a merge whose file never landed, deletes nothing, and merges again", async () => {
    const { tenant, agent } = await setup();
    for (let i = 0; i < 3; i++) await flush(tenant.id, agent.id, 2, `f${i}`);
    const inputs = await files(`tenant=${tenant.id}/`);
    const failingPut: LakeStore = { put: async () => { throw new Error("disk full"); }, list: (p) => store.list(p), delete: (k) => store.delete(k) };

    expect((await compactLake(prisma, { store: failingPut, reader: store }, NOW, FEW)).failedPartitions).toBe(1);
    expect(await files(`tenant=${tenant.id}/`)).toEqual(inputs);

    const second = await compactLake(prisma, io(), NOW, FEW);

    expect(second).toMatchObject({ abandoned: 1, partitionsCompacted: 1, failedPartitions: 0 });
    expect(await files(`tenant=${tenant.id}/`)).toHaveLength(1);
    const rows = await prisma.lakeCompaction.findMany({ orderBy: { startedAt: "asc" } });
    expect(rows.map((r) => r.finishedHow).sort()).toEqual(["abandoned", "compacted"]);
  });

  it("never deletes an input when the merged file is smaller or larger than the one recorded", async () => {
    const { tenant, agent } = await setup();
    for (let i = 0; i < 3; i++) await flush(tenant.id, agent.id, 2, `f${i}`);
    const inputs = await files(`tenant=${tenant.id}/`);
    const corrupting: LakeStore = { put: (k, b) => store.put(k, b.slice(0, b.length - 1)), list: (p) => store.list(p), delete: (k) => store.delete(k) };

    await compactLake(prisma, { store: corrupting, reader: store }, NOW, FEW);

    expect(await files(`tenant=${tenant.id}/`)).toEqual(expect.arrayContaining(inputs));
    expect((await prisma.lakeCompaction.findFirstOrThrow()).finishedHow).toBe("abandoned");
  });

  it("a merged partition is still pruned whole by the retention job", async () => {
    const { tenant, agent } = await setup(30);
    for (let i = 0; i < 3; i++) await flush(tenant.id, agent.id, 25, `f${i}`);
    await compactLake(prisma, io(), NOW, FEW);
    expect(await files(`tenant=${tenant.id}/`)).toHaveLength(1);

    const later = new Date(NOW.getTime() + 10 * DAY);
    const pruned = await pruneLake(prisma, store, later);

    expect(pruned).toMatchObject({ partitionsDeleted: 1, filesDeleted: 1, notEmpty: 0 });
    expect(await files(`tenant=${tenant.id}/`)).toEqual([]);
  });

  it("derives the merged key from the inputs, whatever their order", () => {
    expect(compactedKey("t", "2026-11-07", "exec", ["a", "b"])).toBe(compactedKey("t", "2026-11-07", "exec", ["b", "a"]));
    expect(compactedKey("t", "2026-11-07", "exec", ["a", "b"])).not.toBe(compactedKey("t", "2026-11-07", "exec", ["a", "c"]));
  });

  it("the cron route needs the secret, answers 503 when the lake is off, and compacts when it is on", async () => {
    const req = (secret?: string) => new NextRequest("http://localhost/api/cron/compact-lake", { headers: secret ? { authorization: `Bearer ${secret}` } : {} });
    expect((await compactRoute(req())).status).toBe(401);
    expect((await compactRoute(req("test_cron_secret"))).status).toBe(503);

    process.env.LAKE_DIR = dir;
    const res = await compactRoute(req("test_cron_secret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ partitionsCompacted: 0, failedPartitions: 0 });
    expect(await readdir(dir)).toEqual([]);
  });
});
