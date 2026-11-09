import { NextRequest, NextResponse } from "next/server";
import { verifyCronRequest } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { findOpenSilentCases, silentCaseDescription, silentCaseTitle } from "@/lib/silent-agent-case";

const SILENCE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export async function GET(req: NextRequest) {
  try {
    const denied = await verifyCronRequest(req);
    if (denied) {
      return denied;
    }

    const threshold = new Date(Date.now() - SILENCE_THRESHOLD_MS);

    // Find silent agents
    const silentAgents = await prisma.agent.findMany({
      where: {
        lastSeen: { lt: threshold },
      },
      include: { tenant: true },
    });

    const byTenant = new Map<string, typeof silentAgents>();
    for (const agent of silentAgents) {
      byTenant.set(agent.tenantId, [...(byTenant.get(agent.tenantId) ?? []), agent]);
    }

    let casesCreated = 0;

    // Open one case per silent agent that has none open yet.
    for (const [tenantId, agents] of Array.from(byTenant.entries())) {
      const open = await findOpenSilentCases(prisma, tenantId, agents.map((a) => a.enrollmentId));
      for (const agent of agents) {
        if (open.has(agent.enrollmentId)) continue;
        await prisma.case.create({
          data: {
            tenantId,
            title: silentCaseTitle(agent),
            description: silentCaseDescription(agent),
            severity: "high",
            status: "open",
          },
        });
        casesCreated++;
      }
    }

    return NextResponse.json({
      silentAgents: silentAgents.length,
      casesCreated,
      threshold: threshold.toISOString(),
    });
  } catch (error) {
    console.error("Silent agent detection error:", error);

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
