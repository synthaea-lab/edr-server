import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { extractEnrollmentId } from "@/lib/tenant";
import { CorpusSubmissionSchema, submitSamples } from "@/lib/corpus";
import { route } from "@/lib/http/handler";

/**
 * POST /api/corpus/submit
 * Agent endpoint: Submit benign telemetry samples for T3 corpus curation
 *
 * Authentication: mTLS (X-Client-Cert-Verified + X-Client-Cert-Subject)
 * Request body: { corpusVersion: number, samples: Array<CorpusSample> }
 * Response: { status: "accepted", samplesAccepted, corpusVersion, totalSamples }
 */
export const POST = route("POST /api/corpus/submit", async (req: NextRequest) => {
  const certVerified = req.headers.get("X-Client-Cert-Verified");
  const certSubject = req.headers.get("X-Client-Cert-Subject");
  if (certVerified !== "SUCCESS" || !certSubject) {
    return NextResponse.json(
      { error: "Unauthorized - mTLS authentication required" },
      { status: 401 }
    );
  }

  const enrollmentId = extractEnrollmentId(certSubject);
  if (!enrollmentId) {
    return NextResponse.json({ error: "Invalid certificate subject" }, { status: 400 });
  }

  const agent = await prisma.agent.findUnique({
    where: { enrollmentId },
    select: { id: true, tenantId: true },
  });
  if (!agent) {
    return NextResponse.json({ error: "Agent not enrolled" }, { status: 403 });
  }

  const submission = CorpusSubmissionSchema.parse(await req.json());
  const { corpusVersion, samples } = submission;
  const result = await submitSamples(prisma, agent, submission);

  if (result.outcome === "notCollecting") {
    return NextResponse.json(
      {
        error: "Corpus version is finalized",
        message: `Version ${corpusVersion} is no longer accepting samples (status: ${result.status})`,
      },
      { status: 409 }
    );
  }
  return NextResponse.json({
    status: "accepted",
    samplesAccepted: samples.length,
    corpusVersion,
    totalSamples: result.totalSamples,
  });
});
