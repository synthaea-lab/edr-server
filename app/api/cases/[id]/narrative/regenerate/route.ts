import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireTenantMember } from "@/lib/admin-auth";
import { BadRequest, NotFound, route } from "@/lib/http/handler";
import { buildEvidenceGraph } from "@/assistant/evidence-graph";
import { generateNarrative, NarrativeGenerationError } from "@/assistant/llm-client";

/**
 * POST /api/cases/[id]/narrative/regenerate
 *
 * Analyst-triggered (or system-triggered) case narration (issue #50).
 * Explicit action, not a side effect of viewing the case: an implicit
 * generate-on-GET would couple page loads to LLM latency/failures and
 * double-spend calls on repeated views.
 *
 * Response: { narrative: CaseNarrative }
 */
export const POST = route(
  "POST /api/cases/[id]/narrative/regenerate",
  async (req: NextRequest, { params }: { params: { id: string } }) => {
    const authed = requireTenantMember(req);
    if ("response" in authed) return authed.response;
    const { tenantId, userId } = authed;
    const caseId = params.id;

    const graph = await buildEvidenceGraph(tenantId, caseId);
    if (!graph) throw new NotFound("Case not found");
    if (graph.items.length === 0) throw new BadRequest("Case has no evidence to narrate");

    const result = await generateNarrative(graph);

    const narrative = await prisma.caseNarrative.create({
      data: {
        tenantId,
        caseId,
        narrative: result.text,
        citations: result.citations as unknown as Prisma.InputJsonValue,
        model: result.model,
        provider: result.provider,
        promptVersion: result.promptVersion,
        generatedBy: `user:${userId}`,
      },
    });

    await prisma.auditLog.create({
      data: {
        tenantId,
        userId,
        action: "case.narrative.generate",
        resource: `cases/${caseId}`,
        details: {
          narrativeId: narrative.id,
          model: result.model,
          provider: result.provider,
          promptVersion: result.promptVersion,
          citationCount: result.citations.length,
        },
      },
    });

    return NextResponse.json({ narrative });
  },
  { onError: narrativeFailure }
);

/** The LLM call failing is the upstream's fault, not ours: 502, not the generic 500. */
function narrativeFailure(error: unknown): NextResponse | undefined {
  if (!(error instanceof NarrativeGenerationError)) return undefined;
  console.error("Narrative generation error:", error.message);
  return NextResponse.json({ error: "Narrative generation failed" }, { status: 502 });
}
