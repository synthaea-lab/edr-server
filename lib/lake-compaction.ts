import { createHash, randomUUID } from "node:crypto";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import type { PrismaClient } from "@prisma/client";
import type { LakeReader, LakeStore } from "@/lib/lake-store";
import { dayOf, encodeParquet, isPastRetention, type LakeRow } from "@/lib/lake-writer";

/**
 * Compaction of the telemetry lake (issue #4, ADR-0041 decision 3). The writer puts one small file
 * per (tenant, day, type) per flush; this merges the small files of a closed day into one.
 *
 * Which partitions: a day strictly before today (UTC), of a tenant that keeps events, and not one the
 * retention job could delete within a day (a merge there would race the deletion and could refill a
 * prefix recorded as deleted). A "closed" day is not final: an event with a past timestamp still inside
 * retention adds a small file to it later, and the next run merges that file with the compacted one.
 *
 * Crash safety. The merged file and the deletion of its inputs are two store calls, so a crash between
 * them would leave every row twice. A `LakeCompaction` row is written first, with the output key and the
 * input keys; the next run finishes a row whose output is in the store (deletes the inputs still there)
 * and abandons one whose output never landed (nothing was deleted). The merged key is a hash of its
 * inputs, so a retried merge of the same files rewrites the same file. A reader that lists the partition
 * between the write and the deletes sees the rows twice, for as long as that takes.
 *
 * One compaction per partition at a time: a transaction-scoped advisory lock, held while the files move.
 * Everything is read into memory, so a run takes at most {@link MAX_INPUT_BYTES} of input per partition;
 * what is left waits for the next run.
 */

/** A file under this size is a candidate: a flush's file. Merged files are larger once a day holds enough events. */
export const SMALL_FILE_BYTES = 8 * 1024 * 1024;
/** A partition is compacted once it holds at least this many candidates. */
export const MIN_FILES = 8;
/** The most input read for one merge. */
export const MAX_INPUT_BYTES = 128 * 1024 * 1024;
/** Partitions merged by one run, so that a run stays short; the rest wait. */
export const MAX_PARTITIONS = 50;

const PARTITION_KEY = /^tenant=([A-Za-z0-9_-]+)\/date=(\d{4}-\d{2}-\d{2})\/type=([a-z][a-z0-9_]{0,63})\/[A-Za-z0-9_.-]+\.parquet$/;
const COLUMNS = ["agent_id", "ts", "comm", "path", "image_path", "daddr", "query", "sha256", "event"];
const DAY_MS = 24 * 60 * 60 * 1000;

export type CompactionResult = {
  runId: string;
  partitionsCompacted: number;
  filesMerged: number;
  bytesBefore: number;
  bytesAfter: number;
  /** Rows of an earlier, interrupted merge that this run finished (inputs deleted). */
  finished: number;
  /** Rows of an earlier merge whose output never landed: given up, nothing had been deleted. */
  abandoned: number;
  failedPartitions: number;
  errors: string[];
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const MAX_ERRORS = 5;

type Listed = { key: string; size: number };

/** The merged file's key: the hash of its sorted input keys, so a retried merge writes the same file. */
export function compactedKey(tenantId: string, day: string, type: string, inputKeys: string[]): string {
  const hash = createHash("sha256").update([...inputKeys].sort().join("\n")).digest("hex").slice(0, 32);
  return `tenant=${tenantId}/date=${day}/type=${type}/c-${hash}.parquet`;
}

function toRow(r: Record<string, unknown>): LakeRow {
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    agentId: String(r.agent_id ?? ""),
    at: r.ts instanceof Date ? r.ts : new Date(Number(r.ts)),
    comm: text(r.comm),
    path: text(r.path),
    imagePath: text(r.image_path),
    daddr: text(r.daddr),
    query: text(r.query),
    sha256: text(r.sha256),
    event: String(r.event ?? ""),
  };
}

async function readRows(reader: LakeReader, key: string): Promise<LakeRow[]> {
  const bytes = await reader.get(key);
  const file = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return ((await parquetReadObjects({ file, columns: COLUMNS })) as Record<string, unknown>[]).map(toRow);
}

/** Whether the compactor may touch this day: closed, and not about to be pruned. */
export function isCompactable(day: string, retentionDays: number, now: Date): boolean {
  if (retentionDays <= 0) return false;
  if (day >= dayOf(now)) return false;
  return !isPastRetention(day, retentionDays, new Date(now.getTime() + DAY_MS));
}

export async function compactLake(
  prisma: PrismaClient,
  io: { store: LakeStore; reader: LakeReader },
  now: Date = new Date(),
  opts: { minFiles?: number; smallBytes?: number; maxInputBytes?: number; maxPartitions?: number } = {}
): Promise<CompactionResult> {
  const store = io.store;
  const reader = io.reader;
  const minFiles = opts.minFiles ?? MIN_FILES;
  const smallBytes = opts.smallBytes ?? SMALL_FILE_BYTES;
  const maxInputBytes = opts.maxInputBytes ?? MAX_INPUT_BYTES;
  const maxPartitions = opts.maxPartitions ?? MAX_PARTITIONS;
  const result: CompactionResult = {
    runId: randomUUID(),
    partitionsCompacted: 0,
    filesMerged: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    finished: 0,
    abandoned: 0,
    failedPartitions: 0,
    errors: [],
  };
  const fail = (where: string, e: unknown) => {
    result.failedPartitions += 1;
    if (result.errors.length < MAX_ERRORS) result.errors.push(`${where}: ${message(e)}`);
    console.error(`Lake compaction: ${where}:`, e);
  };

  const tenants = await prisma.tenant.findMany({ select: { id: true, lakeRetentionDays: true } });
  // Interrupted merges first, wherever they are: they hold files that a reader sees twice.
  const pending = await prisma.lakeCompaction.findMany({ where: { completedAt: null }, orderBy: { startedAt: "asc" } });
  const retention = new Map(tenants.map((t) => [t.id, t.lakeRetentionDays]));

  for (const row of pending) {
    const where = `tenant=${row.tenantId}/date=${row.date}/type=${row.type}`;
    try {
      await withPartitionLock(prisma, where, async () => {
        const how = await settle(prisma, store, row);
        if (how === "compacted") result.finished += 1;
        else result.abandoned += 1;
      });
    } catch (e) {
      fail(where, e);
    }
  }

  let done = 0;
  for (const tenant of tenants) {
    if (done >= maxPartitions) break;
    let listed: Listed[];
    try {
      listed = await store.list(`tenant=${tenant.id}/`);
    } catch (e) {
      fail(`tenant=${tenant.id}`, e);
      continue;
    }
    const partitions = new Map<string, { day: string; type: string; files: Listed[] }>();
    for (const f of listed) {
      const m = PARTITION_KEY.exec(f.key);
      if (!m || m[1] !== tenant.id) continue;
      const pk = `${m[2]}/${m[3]}`;
      const p = partitions.get(pk) ?? { day: m[2], type: m[3], files: [] };
      p.files.push(f);
      partitions.set(pk, p);
    }
    for (const p of Array.from(partitions.values())) {
      if (done >= maxPartitions) break;
      if (!isCompactable(p.day, retention.get(tenant.id) ?? 0, now)) continue;
      if (p.files.filter((f) => f.size < smallBytes).length < minFiles) continue;
      const where = `tenant=${tenant.id}/date=${p.day}/type=${p.type}`;
      try {
        await withPartitionLock(prisma, where, async () => {
          // Re-listed under the lock: another run may have merged this partition since the first listing.
          const fresh = (await store.list(`${where}/`)).filter((f) => PARTITION_KEY.test(f.key));
          const small = fresh.filter((f) => f.size < smallBytes);
          if (small.length < minFiles) return;
          let total = 0;
          const inputs: Listed[] = [];
          for (const f of small) {
            if (inputs.length > 0 && total + f.size > maxInputBytes) break;
            inputs.push(f);
            total += f.size;
          }
          const out = await mergePartition(prisma, store, reader, tenant.id, p.day, p.type, inputs, result.runId, now);
          result.partitionsCompacted += 1;
          result.filesMerged += inputs.length;
          result.bytesBefore += total;
          result.bytesAfter += out;
          done += 1;
        });
      } catch (e) {
        fail(where, e);
      }
    }
  }
  return result;
}

/** One compaction per partition at a time; the lock is released when the transaction ends. */
async function withPartitionLock(prisma: PrismaClient, where: string, work: () => Promise<void>): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      const lock = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${`compact:${where}`})) AS ok`;
      if (!lock[0]?.ok) return;
      await work();
    },
    { timeout: 300_000, maxWait: 10_000 }
  );
}

/** Returns the merged file's size. */
async function mergePartition(
  prisma: PrismaClient,
  store: LakeStore,
  reader: LakeReader,
  tenantId: string,
  day: string,
  type: string,
  inputs: Listed[],
  runId: string,
  now: Date
): Promise<number> {
  const rows: LakeRow[] = [];
  for (const f of inputs) rows.push(...(await readRows(reader, f.key)));
  // Oldest first, then input order (a stable sort): what a reader gets from the files one after the other.
  rows.sort((a, b) => a.at.getTime() - b.at.getTime());
  const bytes = encodeParquet(rows);
  const encoded = Number(parquetMetadata(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer).num_rows);
  if (encoded !== rows.length) throw new Error(`merged file holds ${encoded} rows, expected ${rows.length}: nothing deleted`);

  const inputKeys = inputs.map((f) => f.key);
  const outputKey = compactedKey(tenantId, day, type, inputKeys);
  // Intent first. If this cannot be written nothing has moved.
  const record = await prisma.lakeCompaction.create({
    data: {
      tenantId,
      date: day,
      type,
      runId,
      outputKey,
      inputKeys,
      rowCount: rows.length,
      bytesIn: BigInt(inputs.reduce((n, f) => n + f.size, 0)),
      bytesOut: BigInt(bytes.byteLength),
      startedAt: now,
    },
  });
  await store.put(outputKey, bytes);
  await settle(prisma, store, record);
  return bytes.byteLength;
}

/**
 * Finishes a compaction row. If its output is in the store at the size it was written, the inputs
 * still there are deleted and the row is "compacted"; if not, the merge is given up ("abandoned") and
 * no input is touched. Throws when the store fails: the row stays open for the next run.
 */
async function settle(
  prisma: PrismaClient,
  store: LakeStore,
  row: { id: string; tenantId: string; date: string; type: string; outputKey: string; inputKeys: unknown; bytesOut: bigint }
): Promise<"compacted" | "abandoned"> {
  const where = `tenant=${row.tenantId}/date=${row.date}/type=${row.type}`;
  const listed = await store.list(`${where}/`);
  const present = new Map(listed.map((f) => [f.key, f.size]));
  const inputKeys = (Array.isArray(row.inputKeys) ? row.inputKeys : []).filter((k): k is string => typeof k === "string");

  if (present.get(row.outputKey) !== Number(row.bytesOut)) {
    await prisma.lakeCompaction.update({
      where: { id: row.id },
      data: { completedAt: new Date(), finishedHow: "abandoned", deletedCount: 0, error: "the merged file is not in the store" },
    });
    return "abandoned";
  }
  // Never the output itself, even if a key list were wrong.
  const toDelete = inputKeys.filter((k) => k !== row.outputKey && present.has(k));
  const res = await store.delete(toDelete);
  if (res.failed.length > 0) {
    await prisma.lakeCompaction.update({ where: { id: row.id }, data: { deletedCount: res.deleted.length, error: `${res.failed[0].key}: ${res.failed[0].error}` } });
    throw new Error(`could not delete ${res.failed.length} merged input(s): ${res.failed[0].key}: ${res.failed[0].error}`);
  }
  await prisma.lakeCompaction.update({
    where: { id: row.id },
    data: { completedAt: new Date(), finishedHow: "compacted", deletedCount: res.deleted.length, error: null },
  });
  return "compacted";
}
