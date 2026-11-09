import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireTenantAdmin, requireTenantMember } from "@/lib/admin-auth";
import { z } from "zod";
import { publishRelease } from "@/lib/release-publish";
import { publishResponse } from "@/lib/http/publish-response";

const CreateReleaseSchema = z.object({
  ring: z.enum(["canary_0", "canary_1", "canary_2", "prod"]),
  manifestUrl: z.string().url(),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  releasedAt: z.string().datetime().optional(),
  // The release this one restores, when it is a corrective release answering a rollback's
  // advice (ADR-0032): recorded in the audit entry, never checked against anything — the
  // server has no independent way to tell a corrective release from an ordinary one, and the
  // caller is already admin-authenticated by the time this is read.
  restoresVersion: z.number().int().positive().optional(),
});

/**
 * POST /api/content/release
 * Admin endpoint: Create new content release for a ring
 *
 * Authentication: better-auth session, `owner` or `admin` member of the tenant (#803)
 * Request body: { ring, manifestUrl, manifestSha256, releasedAt?, restoresVersion? }
 * Response: { release: ContentRelease }
 *
 * The release is numbered one above the ring's highest (rolled-back releases included) and
 * is refused (422) unless its manifest is the one named by `manifestUrl`/`manifestSha256`,
 * lists at least one entry, is for this ring and carries that number, and every artifact it
 * lists is in `storage/artifacts` and hashes to the manifest's value.
 */
export async function POST(req: NextRequest) {
  try {
    const authed = await requireTenantAdmin(req);
    if ("response" in authed) return authed.response;
    const { tenantId, userId } = authed;

    // Parse request body
    const body = await req.json();
    const validation = CreateReleaseSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: "Invalid request", details: validation.error.errors },
        { status: 400 }
      );
    }

    return publishResponse(
      await publishRelease(prisma, { kind: "content", tenantId, userId, ...validation.data })
    );
  } catch (error) {
    console.error("Content release creation error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/content/release
 * Lists content releases for the caller's tenant — any signed-in member, not admin-only: a
 * read of release history carries none of POST's fleet-wide write risk (#803).
 *
 * Query params:
 * - ring: Filter by ring (optional)
 * - status: Filter by status (optional)
 * - limit: Number of results (default: 50, max: 1000)
 *
 * Response: { releases: ContentRelease[] }
 */
export async function GET(req: NextRequest) {
  try {
    const authed = requireTenantMember(req);
    if ("response" in authed) return authed.response;
    const { tenantId } = authed;
    const { searchParams } = new URL(req.url);

    const ring = searchParams.get("ring");
    const status = searchParams.get("status");
    const limit = parseInt(searchParams.get("limit") || "50", 10);

    const releases = await prisma.contentRelease.findMany({
      where: {
        tenantId,
        ...(ring && { ring }),
        ...(status && { status }),
      },
      orderBy: [{ ring: "asc" }, { releaseVersion: "desc" }],
      take: Math.min(limit, 1000),
    });

    return NextResponse.json({ releases });
  } catch (error) {
    console.error("Content releases query error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
