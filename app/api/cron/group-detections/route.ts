import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { verifyCronRequest } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import {
  GROUPING_BATCH_SIZE,
  groupingTechnique,
  isRelatedTechnique,
  outranksSeverity,
  withinTimeWindow,
} from "@/lib/case-grouping";
import { perTenantResponse, runPerTenant } from "@/lib/cron/per-tenant";

interface CandidateCase {
  id: string;
  severity: string;
  /** `technique` is the grouping tag (`groupingTechnique`), not the stored column. */
  detections: { agentId: string; timestamp: Date; technique: string }[];
}

/** `meta.techniques` of a detection, if its `meta` is an object at all. */
function listedTechniques(meta: Prisma.JsonValue): unknown {
  return typeof meta === "object" && meta !== null && !Array.isArray(meta) ? meta.techniques : undefined;
}

/** Fixed first key of this cron's per-tenant advisory lock (`lib/cron/per-tenant.ts`). */
const GROUPING_LOCK_KEY = 50_262_001;

/** Names this cron in its log lines. */
const GROUPING_LABEL = "Detection grouping";

/** One tenant's grouping pass. */
interface TenantGroupingResult {
  casesCreated: number;
  detectionsGrouped: number;
  moreWorkLikely: boolean;
}

/**
 * GET /api/cron/group-detections
 *
 * Cron endpoint (issue #50): groups ungrouped detections (`caseId: null`)
 * into a Case per tenant, so the case store has an evidence graph for
 * narrative generation to work from. Heuristic: same agent + related MITRE
 * technique to something already in the case, and within a 30 minute window
 * of the *case's earliest* detection (not just its most recent one, which
 * would let the window drift indefinitely as detections chain together) —
 * attaches to an existing open case; otherwise a new case is created.
 * Idempotent — re-running only ever touches detections still at
 * `caseId: null`.
 *
 * One transaction per tenant, each with its own timeout budget, advisory lock
 * and error handling (`runPerTenant`, which documents why).
 *
 * `moreWorkLikely` tells the caller whether any tenant's batch came back full
 * (backlog possibly larger than one batch) without an extra count query.
 *
 * Authentication: Bearer token (CRON_SECRET)
 * Response body: { tenantsChecked, tenantsSkipped, tenantsFailed,
 *   casesCreated, detectionsGrouped, moreWorkLikely[, error] } —
 *   `tenantsSkipped` counts tenants another invocation already held the lock
 *   for; `tenantsFailed` counts tenants whose transaction threw. Neither is a
 *   whole-request skip. Status: 200, 207 when some tenants failed, 502 when
 *   every one did (`perTenantResponse`).
 */
export async function GET(req: NextRequest) {
  try {
    const denied = await verifyCronRequest(req);
    if (denied) {
      return denied;
    }

    const summary = await runPerTenant(
      prisma,
      { lockKey: GROUPING_LOCK_KEY, label: GROUPING_LABEL },
      groupOneTenant
    );
    const { results } = summary;
    return perTenantResponse(GROUPING_LABEL, summary, {
      casesCreated: results.reduce((n, r) => n + r.casesCreated, 0),
      detectionsGrouped: results.reduce((n, r) => n + r.detectionsGrouped, 0),
      moreWorkLikely: results.some((r) => r.moreWorkLikely),
    });
  } catch (error) {
    console.error("Detection grouping error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** Groups one tenant's ungrouped detections, inside the transaction and
 * advisory lock `runPerTenant` holds for it. */
async function groupOneTenant(
  tx: Prisma.TransactionClient,
  tenantId: string
): Promise<TenantGroupingResult> {
  const ungrouped = await tx.detection.findMany({
    where: { tenantId, caseId: null },
    orderBy: { timestamp: "asc" },
    take: GROUPING_BATCH_SIZE,
  });

  if (ungrouped.length === 0) {
    return { casesCreated: 0, detectionsGrouped: 0, moreWorkLikely: false };
  }
  // A full batch doesn't prove more is queued (could land exactly on the
  // cap), but it's the cheap signal available without a second count query —
  // a false positive here just costs one extra tick that finds nothing left.
  const moreWorkLikely = ungrouped.length === GROUPING_BATCH_SIZE;

  // Only `meta.techniques` is read for the evidence already in open cases: the rest of
  // `meta` (attributions, further triggering events) is not needed to group.
  const listedRows = await tx.$queryRaw<{ id: string; techniques: unknown }[]>`
    SELECT d.id, d.meta->'techniques' AS techniques
    FROM detections d JOIN cases c ON c.id = d.case_id
    WHERE c.tenant_id = ${tenantId} AND c.status = 'open'
  `;
  const listedById = new Map(listedRows.map((row) => [row.id, row.techniques]));
  const openCases: CandidateCase[] = (
    await tx.case.findMany({
      where: { tenantId, status: "open" },
      select: {
        id: true,
        severity: true,
        detections: { select: { id: true, agentId: true, timestamp: true, technique: true } },
      },
    })
  ).map((c) => ({
    ...c,
    detections: c.detections.map(({ id, ...d }) => ({
      ...d,
      technique: groupingTechnique(d.technique, listedById.get(id)),
    })),
  }));

  const agents = await tx.agent.findMany({
    where: { tenantId },
    select: { id: true, hostname: true },
  });
  const hostnameByAgentId = new Map(agents.map((a) => [a.id, a.hostname]));

  let casesCreated = 0;
  let detectionsGrouped = 0;
  // detection id -> target case id, applied as one updateMany per case after
  // the decision loop instead of one update per detection.
  const assignments = new Map<string, string[]>();

  for (const detection of ungrouped) {
    const technique = groupingTechnique(detection.technique, listedTechniques(detection.meta));
    const match = openCases.find((c) => {
      if (c.detections.length === 0) {
        return false;
      }
      const caseStart = Math.min(...c.detections.map((d) => d.timestamp.getTime()));
      const sameAgentRelatedTechnique = c.detections.some(
        (d) => d.agentId === detection.agentId && isRelatedTechnique(d.technique, technique)
      );
      return sameAgentRelatedTechnique && withinTimeWindow(new Date(caseStart), detection.timestamp);
    });

    let targetCase: CandidateCase;
    if (match) {
      targetCase = match;
    } else {
      const hostname = hostnameByAgentId.get(detection.agentId);
      const created = await tx.case.create({
        data: {
          tenantId,
          title: `${detection.technique} activity on ${hostname ?? detection.agentId}`,
          severity: detection.severity,
          status: "open",
        },
        select: { id: true, severity: true },
      });
      targetCase = { ...created, detections: [] };
      openCases.push(targetCase);
      casesCreated++;
    }

    const existing = assignments.get(targetCase.id) ?? [];
    existing.push(detection.id);
    assignments.set(targetCase.id, existing);
    detectionsGrouped++;

    if (outranksSeverity(detection.severity, targetCase.severity)) {
      await tx.case.update({
        where: { id: targetCase.id },
        data: { severity: detection.severity },
      });
      targetCase.severity = detection.severity;
    }

    targetCase.detections.push({
      agentId: detection.agentId,
      timestamp: detection.timestamp,
      technique,
    });
  }

  for (const [caseId, detectionIds] of Array.from(assignments)) {
    await tx.detection.updateMany({
      where: { id: { in: detectionIds } },
      data: { caseId },
    });
  }

  return { casesCreated, detectionsGrouped, moreWorkLikely };
}
