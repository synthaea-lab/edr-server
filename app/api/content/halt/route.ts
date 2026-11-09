import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireTenantAdmin } from "@/lib/admin-auth";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { lockContentRing } from "@/lib/content-rollback";

const HaltSchema = z.object({
  ring: z.enum(["canary_0", "canary_1", "canary_2", "prod"]),
  reason: z.string().optional(),
});

/**
 * POST /api/content/halt
 * Admin endpoint: Halt content deployment for a ring
 *
 * Marks the latest active release as "halted". Agents will stop fetching
 * new content for this ring until it's resumed or rolled back.
 *
 * Authentication: better-auth session, owner/admin member of the tenant (#803)
 * Request body: { ring, reason? }
 * Response: { status: "halted", release: ContentRelease }
 */
export async function POST(req: NextRequest) {
  try {
    const authed = await requireTenantAdmin(req);
    if ("response" in authed) return authed.response;
    const { tenantId, userId } = authed;

    // Parse request body
    const body = await req.json();
    const validation = HaltSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: "Invalid request", details: validation.error.errors },
        { status: 400 }
      );
    }

    const { ring, reason } = validation.data;

    // One transaction under the ring's lock: a halt never lands without its audit row, and it
    // never races a rollback of the same ring.
    const haltedRelease = await prisma.$transaction(async (tx) => {
      await lockContentRing(tx, tenantId, ring);

      // Find latest active release for this tenant + ring
      const release = await tx.contentRelease.findFirst({
        where: {
          tenantId,
          ring,
          status: "active",
        },
        orderBy: { releaseVersion: "desc" },
      });
      if (!release) return null;

      const halted = await tx.contentRelease.update({
        where: { id: release.id },
        data: { status: "halted" },
      });

      await recordAudit(tx, {
        tenantId,
        userId,
        action: "content.release.halt",
        resource: `content_releases/${release.id}`,
        details: {
          ring,
          releaseVersion: release.releaseVersion,
          reason: reason || "Manual halt",
        },
      });
      return halted;
    });

    if (!haltedRelease) {
      return NextResponse.json(
        { error: "No active release found for ring" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      status: "halted",
      release: haltedRelease,
    });
  } catch (error) {
    console.error("Content halt error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
