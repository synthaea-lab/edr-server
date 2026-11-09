import { NextRequest, NextResponse } from "next/server";
import { verifyCronRequest } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { groupOneTenant } from "@/lib/case-grouping-store";
import { perTenantResponse, runPerTenant } from "@/lib/cron/per-tenant";

/** Fixed first key of this cron's per-tenant advisory lock (`lib/cron/per-tenant.ts`). */
const GROUPING_LOCK_KEY = 50_262_001;

/** Names this cron in its log lines. */
const GROUPING_LABEL = "Detection grouping";

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
