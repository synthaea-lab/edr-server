import type { Prisma } from "@prisma/client";
import {
  GROUPING_BATCH_SIZE,
  groupingTechnique,
  planGrouping,
  type GroupingPlan,
  type OpenCase,
  type UngroupedDetection,
} from "@/lib/case-grouping";

/**
 * The database side of the detection-grouping cron (issue #50): read one tenant's ungrouped
 * detections and open cases, let `planGrouping` decide, then write the plan. Every function runs
 * inside the transaction and advisory lock `runPerTenant` holds for the tenant.
 */

/** One tenant's grouping pass. */
export interface TenantGroupingResult {
  casesCreated: number;
  detectionsGrouped: number;
  moreWorkLikely: boolean;
}

/** The oldest detections still at `caseId: null`, at most one batch. */
export function loadUngrouped(tx: Prisma.TransactionClient, tenantId: string): Promise<UngroupedDetection[]> {
  return tx.detection.findMany({
    where: { tenantId, caseId: null },
    orderBy: { timestamp: "asc" },
    take: GROUPING_BATCH_SIZE,
    select: { id: true, agentId: true, timestamp: true, technique: true, severity: true, meta: true },
  });
}

/** The tenant's open cases, each detection tagged with its grouping technique. */
export async function loadOpenCases(tx: Prisma.TransactionClient, tenantId: string): Promise<OpenCase[]> {
  // Only `meta.techniques` is read for the evidence already in open cases: the rest of
  // `meta` (attributions, further triggering events) is not needed to group.
  const listedRows = await tx.$queryRaw<{ id: string; techniques: unknown }[]>`
    SELECT d.id, d.meta->'techniques' AS techniques
    FROM detections d JOIN cases c ON c.id = d.case_id
    WHERE c.tenant_id = ${tenantId} AND c.status = 'open'
  `;
  const listedById = new Map(listedRows.map((row) => [row.id, row.techniques]));
  const cases = await tx.case.findMany({
    where: { tenantId, status: "open" },
    select: {
      id: true,
      severity: true,
      detections: { select: { id: true, agentId: true, timestamp: true, technique: true } },
    },
  });
  return cases.map((c) => ({
    ...c,
    detections: c.detections.map(({ id, ...d }) => ({
      ...d,
      technique: groupingTechnique(d.technique, listedById.get(id)),
    })),
  }));
}

/** Hostname of each of the tenant's agents, for new case titles. */
export async function loadHostnames(tx: Prisma.TransactionClient, tenantId: string): Promise<Map<string, string | null>> {
  const agents = await tx.agent.findMany({ where: { tenantId }, select: { id: true, hostname: true } });
  return new Map(agents.map((a) => [a.id, a.hostname]));
}

/**
 * Writes a plan: creates the new cases in plan order, raises the severity of existing cases (one
 * update per case), then moves the detections (one `updateMany` per target case).
 */
export async function applyGroupingPlan(
  tx: Prisma.TransactionClient,
  tenantId: string,
  plan: GroupingPlan
): Promise<void> {
  const assignments = new Map(plan.assignments);
  for (const { title, severity, detectionIds } of plan.newCases) {
    const created = await tx.case.create({
      data: { tenantId, title, severity, status: "open" },
      select: { id: true },
    });
    assignments.set(created.id, detectionIds);
  }

  for (const [caseId, severity] of Array.from(plan.severityBumps)) {
    await tx.case.update({ where: { id: caseId }, data: { severity } });
  }

  for (const [caseId, detectionIds] of Array.from(assignments)) {
    await tx.detection.updateMany({ where: { id: { in: detectionIds } }, data: { caseId } });
  }
}

/** Groups one tenant's ungrouped detections: load, plan, apply. */
export async function groupOneTenant(tx: Prisma.TransactionClient, tenantId: string): Promise<TenantGroupingResult> {
  const ungrouped = await loadUngrouped(tx, tenantId);
  if (ungrouped.length === 0) {
    return { casesCreated: 0, detectionsGrouped: 0, moreWorkLikely: false };
  }

  const plan = planGrouping(ungrouped, await loadOpenCases(tx, tenantId), await loadHostnames(tx, tenantId));
  await applyGroupingPlan(tx, tenantId, plan);

  return {
    casesCreated: plan.newCases.length,
    detectionsGrouped: ungrouped.length,
    // A full batch doesn't prove more is queued (could land exactly on the
    // cap), but it's the cheap signal available without a second count query —
    // a false positive here just costs one extra tick that finds nothing left.
    moreWorkLikely: ungrouped.length === GROUPING_BATCH_SIZE,
  };
}
