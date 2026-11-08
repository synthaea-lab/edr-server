import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireTenantAdmin } from "@/lib/admin-auth";
import { z } from "zod";

const EnrollmentSchema = z.object({
  enrollmentId: z.string(),
  // Self-declared and later shown in alarms: bounded and printable.
  hostname: z
    .string()
    .max(253)
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\x00-\x1f\x7f]*$/)
    .optional(),
  version: z.string().optional(),
});

/**
 * POST /api/enrollment
 * Registers an agent with the caller's tenant (admin-only, tenant-scoped).
 *
 * Authentication: better-auth session, `owner` or `admin` member of the tenant: adding a host
 * to the fleet is a fleet change, like moving one between rings.
 * Response: `enrolled` or `already_enrolled` with the agent's id and ring, or 409 when the
 * enrollment id belongs to another tenant's agent.
 */
export async function POST(req: NextRequest) {
  try {
    const authed = await requireTenantAdmin(req);
    if ("response" in authed) return authed.response;
    const { tenantId, userId } = authed;

    const body = await req.json();
    const { enrollmentId, hostname, version } = EnrollmentSchema.parse(body);

    // `enrollmentId` is unique across tenants, so look it up globally, but only ever describe
    // an agent of the caller's own tenant: anything else would disclose another tenant's
    // agent id and ring to whoever guessed its enrollment id.
    const existing = await prisma.agent.findUnique({
      where: { enrollmentId },
    });

    if (existing && existing.tenantId !== tenantId) {
      return NextResponse.json(
        { error: "Enrollment id already in use" },
        { status: 409 }
      );
    }

    if (existing) {
      return NextResponse.json({
        status: "already_enrolled",
        agentId: existing.id,
        ring: existing.ring,
      });
    }

    // Enroll agent
    const agent = await prisma.agent.create({
      data: {
        tenantId,
        enrollmentId,
        hostname,
        version,
        lastSeen: new Date(),
      },
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        tenantId,
        userId,
        action: "enrollment.create",
        resource: `agents/${agent.id}`,
        details: { enrollmentId, hostname, version },
      },
    });

    return NextResponse.json({
      status: "enrolled",
      agentId: agent.id,
      ring: agent.ring,
    });
  } catch (error) {
    console.error("Enrollment error:", error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid payload", details: error.errors },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
