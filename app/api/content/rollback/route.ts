import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireTenantAdmin } from "@/lib/admin-auth";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import {
  correctiveReleaseAdvice,
  findRollbackReleases,
  lockContentRing,
} from "@/lib/content-rollback";

const RollbackSchema = z.object({
  ring: z.enum(["canary_0", "canary_1", "canary_2", "prod"]),
  targetVersion: z.number().int().min(1).optional(),
  reason: z.string().optional(),
});

/**
 * POST /api/content/rollback
 * Admin endpoint: Rollback content deployment to previous version
 *
 * Marks current release as "rolled_back" and activates a previous release.
 * If targetVersion is not specified, rolls back to the immediate previous version.
 *
 * This only helps agents that have not applied the rolled-back release yet: an agent never
 * goes to a lower release number, so one that already applied it stays on it (ADR-0032). The
 * response says so and names the corrective release that withdraws the content from them.
 *
 * Authentication: better-auth session, `owner` or `admin` member of the tenant (#803)
 * Request body: { ring, targetVersion?, reason? }
 * Response: { status: "rolled_back", previousRelease, activeRelease, correctiveRelease }
 */
export async function POST(req: NextRequest) {
  try {
    const authed = await requireTenantAdmin(req);
    if ("response" in authed) return authed.response;
    const { tenantId, userId } = authed;

    // Parse request body
    const body = await req.json();
    const validation = RollbackSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: "Invalid request", details: validation.error.errors },
        { status: 400 }
      );
    }

    const { ring, targetVersion, reason } = validation.data;

    // The reads and the writes run in one transaction under the ring's lock: a failure between
    // the two status updates must not leave the ring with no active release, a rollback must not
    // land without its audit row, and two rollbacks of a ring must not act on the same read.
    const outcome = await prisma.$transaction(async (tx) => {
      await lockContentRing(tx, tenantId, ring);

      const found = await findRollbackReleases(tx, { tenantId, ring, targetVersion });
      if ("error" in found) return found;
      const { currentRelease, targetRelease } = found;

      // The corrective release must beat every release of the ring, not only the active one.
      const highest = await tx.contentRelease.findFirst({
        where: { tenantId, ring },
        orderBy: { releaseVersion: "desc" },
        select: { releaseVersion: true },
      });
      const advice = correctiveReleaseAdvice(
        highest?.releaseVersion ?? currentRelease.releaseVersion,
        targetRelease.releaseVersion,
      );

      const rolledBackRelease = await tx.contentRelease.update({
        where: { id: currentRelease.id },
        data: { status: "rolled_back" },
      });
      const activatedRelease = await tx.contentRelease.update({
        where: { id: targetRelease.id },
        data: { status: "active" },
      });

      await recordAudit(tx, {
        tenantId,
        userId,
        action: "content.release.rollback",
        resource: `content_releases/${currentRelease.id}`,
        details: {
          ring,
          fromVersion: currentRelease.releaseVersion,
          toVersion: targetRelease.releaseVersion,
          reason: reason || "Manual rollback",
          correctiveReleaseVersion: advice.releaseVersion,
        },
      });

      return { rolledBackRelease, activatedRelease, advice };
    });

    if ("error" in outcome) {
      return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    }
    const { rolledBackRelease, activatedRelease, advice } = outcome;

    return NextResponse.json({
      status: "rolled_back",
      previousRelease: rolledBackRelease,
      activeRelease: activatedRelease,
      correctiveRelease: advice,
    });
  } catch (error) {
    console.error("Content rollback error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
