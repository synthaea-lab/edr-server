import { NextRequest, NextResponse } from "next/server";
import { verifyCronRequest } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { lakeCompactionIoFromEnv } from "@/lib/lake-env";
import { compactLake } from "@/lib/lake-compaction";

/**
 * GET /api/cron/compact-lake
 * Scheduled job: merges the small files of closed days into one per (tenant, day, type) and records
 * each merge in `lake_compactions` (issue #4, ADR-0041 decision 3). Run it daily or less often, after
 * `write-lake`; running it more often only repeats nothing.
 *
 * Authentication: CRON_SECRET bearer (`verifyCronRequest`).
 * 503 when the lake is off. 500, with the counts and the first errors, when a partition failed; the
 * others were still done and an interrupted merge is finished by the next run.
 */
export async function GET(req: NextRequest) {
  try {
    const denied = await verifyCronRequest(req);
    if (denied) return denied;

    const io = lakeCompactionIoFromEnv();
    if (!io) {
      return NextResponse.json({ error: "The telemetry lake is off (LAKE_DIR is not set)" }, { status: 503 });
    }
    const result = await compactLake(prisma, io, new Date());
    return NextResponse.json(result, { status: result.failedPartitions > 0 ? 500 : 200 });
  } catch (error) {
    console.error("Lake compaction error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
