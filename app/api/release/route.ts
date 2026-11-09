import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireTenantAdmin, requireTenantMember } from "@/lib/admin-auth";
import { publishRelease } from "@/lib/release-publish";
import { publishResponse } from "@/lib/http/publish-response";

const CreateReleaseSchema = z.object({
  ring: z.enum(["canary_0", "canary_1", "canary_2", "prod"]),
  releaseVersion: z.number().int().min(1),
  manifestUrl: z.string().min(1),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  releasedAt: z.string().datetime().optional(),
});

/**
 * POST /api/release
 * Admin endpoint: publish a signed binary release to a ring (ADR-0015, #30).
 *
 * Authentication: better-auth session, `owner` or `admin` member of the tenant (#837).
 * Request body: { ring, releaseVersion, manifestUrl, manifestSha256, releasedAt? }
 *
 * Refuses to publish anything an agent could not install: the manifest must
 * hash to `manifestSha256`, match the schema, carry `releaseVersion`, and every
 * entry's artifact must already be in storage and hash to its signed value.
 * The Ed25519 signature is not checked here (the server never holds the key);
 * every agent verifies it before staging. `releaseVersion` must be strictly
 * greater than the ring's latest, mirroring the agent's anti-rollback check.
 */
export async function POST(req: NextRequest) {
  try {
    const authed = await requireTenantAdmin(req);
    if ("response" in authed) return authed.response;
    const { tenantId, userId } = authed;

    const validation = CreateReleaseSchema.safeParse(await req.json());
    if (!validation.success) {
      return NextResponse.json(
        { error: "Invalid request", details: validation.error.errors },
        { status: 400 }
      );
    }
    return publishResponse(
      await publishRelease(prisma, { kind: "binary", tenantId, userId, ...validation.data })
    );
  } catch (error) {
    console.error("Binary release creation error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * GET /api/release
 * Admin endpoint: list the tenant's binary releases.
 * Query params: ring, status (optional), limit (default 50, max 1000).
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

    const releases = await prisma.binaryRelease.findMany({
      where: { tenantId, ...(ring && { ring }), ...(status && { status }) },
      orderBy: [{ ring: "asc" }, { releaseVersion: "desc" }],
      take: Math.min(Number.isNaN(limit) ? 50 : limit, 1000),
    });
    return NextResponse.json({ releases });
  } catch (error) {
    console.error("Binary releases query error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
