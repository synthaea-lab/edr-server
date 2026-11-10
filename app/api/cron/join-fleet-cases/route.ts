import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { verifyCronRequest } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import {
  candidateHashes,
  type FleetGroup,
  joinDetections,
} from "@/lib/fleet-case";
import { ranksAtLeast } from "@/lib/severity";
import { loadFleetPrevalence } from "@/lib/fleet-prevalence";
import { perTenantResponse, runPerTenant } from "@/lib/cron/per-tenant";

/** Fixed first key of this cron's per-tenant advisory lock (`lib/cron/per-tenant.ts`): two
 * overlapping invocations would otherwise both open a case for the same group. */
const JOIN_LOCK_KEY = 62_262_001;

/** Names this cron in its log lines. */
const JOIN_LABEL = "Fleet case join";

/** How far back detections are read: the join window is a day, so a week leaves room for a late
 * detection to join an older sighting without the sweep reading the whole table. */
const JOIN_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** Per-tenant cap on detections read in one invocation, newest first (the same reasoning as
 * `GROUPING_BATCH_SIZE`: a bounded transaction, and the next tick continues). */
const JOIN_BATCH_SIZE = 5000;

interface TenantJoinResult {
  fleetCasesCreated: number;
  fleetCasesMerged: number;
  detectionsJoined: number;
  moreWorkLikely: boolean;
}

/**
 * GET /api/cron/join-fleet-cases
 *
 * Cron endpoint (issue #62, box 1): joins each tenant's recent detections across hosts by a shared
 * entity (`lib/fleet-case.ts`: a file hash or an identity, with its caps) into fleet cases.
 * Idempotent: a run over the same detections changes nothing. An entity belongs to one fleet case
 * per tenant, so a later sighting grows it, and a detection that bridges two cases merges them
 * into the older one. A fleet case's severity is the highest of its detections and never goes
 * down. It reads detections and writes only `FleetCase`, `FleetCaseEntity` and
 * `Detection.fleetCaseId`; a detection's own host case is untouched.
 *
 * One transaction per tenant, with its own advisory lock, so one tenant's failure or slowness does
 * not stop the others (`runPerTenant`). Authentication: Bearer token (CRON_SECRET).
 * Status: 200, 207 when some tenants failed, 502 when every one did (`perTenantResponse`).
 */
export async function GET(req: NextRequest) {
  try {
    const denied = await verifyCronRequest(req);
    if (denied) return denied;

    const summary = await runPerTenant(prisma, { lockKey: JOIN_LOCK_KEY, label: JOIN_LABEL }, joinOneTenant);
    const { results } = summary;
    return perTenantResponse(JOIN_LABEL, summary, {
      fleetCasesCreated: results.reduce((n, r) => n + r.fleetCasesCreated, 0),
      fleetCasesMerged: results.reduce((n, r) => n + r.fleetCasesMerged, 0),
      detectionsJoined: results.reduce((n, r) => n + r.detectionsJoined, 0),
      moreWorkLikely: results.some((r) => r.moreWorkLikely),
    });
  } catch (error) {
    console.error("Fleet case join error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

async function joinOneTenant(tx: Prisma.TransactionClient, tenantId: string): Promise<TenantJoinResult> {
  const detections = await tx.detection.findMany({
    where: { tenantId, timestamp: { gte: new Date(Date.now() - JOIN_LOOKBACK_MS) } },
    select: { id: true, agentId: true, timestamp: true, severity: true, event: true, fleetCaseId: true },
    orderBy: { timestamp: "desc" },
    take: JOIN_BATCH_SIZE,
  });
  const moreWorkLikely = detections.length === JOIN_BATCH_SIZE;
  const prevalence = await loadFleetPrevalence(tx, tenantId, candidateHashes(detections));
  const groups = joinDetections(detections, prevalence);

  let fleetCasesCreated = 0;
  let fleetCasesMerged = 0;
  let detectionsJoined = 0;
  for (const group of groups) {
    const outcome = await upsertGroup(tx, tenantId, group);
    fleetCasesCreated += outcome.created ? 1 : 0;
    fleetCasesMerged += outcome.merged;
    detectionsJoined += outcome.detectionsJoined;
  }
  return { fleetCasesCreated, fleetCasesMerged, detectionsJoined, moreWorkLikely };
}

async function upsertGroup(tx: Prisma.TransactionClient, tenantId: string, group: FleetGroup) {
  const known = await tx.fleetCaseEntity.findMany({
    where: { tenantId, OR: group.entities.map((e) => ({ kind: e.kind, key: e.key })) },
    select: { fleetCaseId: true },
  });
  const existingIds = Array.from(new Set(known.map((k) => k.fleetCaseId)));

  let targetId: string;
  let created = false;
  let merged = 0;
  if (existingIds.length === 0) {
    const row = await tx.fleetCase.create({
      data: {
        tenantId,
        severity: group.severity,
        agentCount: group.agentIds.length,
        firstAt: group.firstAt,
        lastAt: group.lastAt,
      },
    });
    targetId = row.id;
    created = true;
  } else {
    const [oldest, ...others] = await tx.fleetCase.findMany({
      where: { id: { in: existingIds } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    targetId = oldest.id;
    if (others.length > 0) {
      const otherIds = others.map((o) => o.id);
      await tx.detection.updateMany({ where: { fleetCaseId: { in: otherIds } }, data: { fleetCaseId: targetId } });
      await tx.fleetCaseEntity.updateMany({ where: { fleetCaseId: { in: otherIds } }, data: { fleetCaseId: targetId } });
      await tx.fleetCase.deleteMany({ where: { id: { in: otherIds } } });
      merged = others.length;
    }
  }

  await tx.fleetCaseEntity.createMany({
    data: group.entities.map((e) => ({ tenantId, fleetCaseId: targetId, kind: e.kind, key: e.key })),
    skipDuplicates: true,
  });
  // Only the detections not already on this case, so a rerun does not bump `updatedAt` (the
  // staleness of a case narrative compares against it).
  const linked = await tx.detection.updateMany({
    where: {
      tenantId,
      id: { in: group.detectionIds },
      OR: [{ fleetCaseId: null }, { fleetCaseId: { not: targetId } }],
    },
    data: { fleetCaseId: targetId },
  });

  // Recomputed from every detection of the case, not only this batch: it may be wider.
  const members = await tx.detection.findMany({
    where: { tenantId, fleetCaseId: targetId },
    select: { agentId: true, timestamp: true, severity: true },
  });
  const current = await tx.fleetCase.findUniqueOrThrow({ where: { id: targetId } });
  const times = members.map((m) => m.timestamp.getTime());
  const next = {
    agentCount: new Set(members.map((m) => m.agentId)).size,
    firstAt: new Date(Math.min(...times)),
    lastAt: new Date(Math.max(...times)),
    severity: members.reduce(
      (top, m) => (ranksAtLeast(m.severity, top) ? m.severity : top),
      current.severity
    ),
  };
  if (
    next.agentCount !== current.agentCount ||
    next.firstAt.getTime() !== current.firstAt.getTime() ||
    next.lastAt.getTime() !== current.lastAt.getTime() ||
    next.severity !== current.severity
  ) {
    await tx.fleetCase.update({ where: { id: targetId }, data: next });
  }
  return { created, merged, detectionsJoined: linked.count };
}
