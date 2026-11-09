import { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";

/**
 * Benign telemetry samples agents submit for T3 corpus curation. A tenant's corpus version
 * collects samples until an admin finalizes it; after that it accepts no more.
 */

const CorpusSampleSchema = z.object({
  timestamp: z.string().datetime(),
  eventType: z.string(),
  event: z.record(z.any()), // Normalized schema::Event
});

export const CorpusSubmissionSchema = z.object({
  corpusVersion: z.number().int().min(1),
  samples: z.array(CorpusSampleSchema).min(1).max(1000), // Max 1000 samples per batch
});

export type CorpusSubmission = z.infer<typeof CorpusSubmissionSchema>;

export type CorpusDb = Pick<PrismaClient, "$transaction">;

export type SubmitOutcome =
  /** `totalSamples` is the version's sample count once this batch is in. */
  | { outcome: "accepted"; totalSamples: number }
  /** The version exists but is no longer collecting (finalized or archived). */
  | { outcome: "notCollecting"; status: string };

/**
 * Adds `samples` to the tenant's corpus version `corpusVersion`, creating the version on its
 * first submit, in one transaction:
 *
 * - the version is created with `ON CONFLICT DO NOTHING`, so two agents submitting the first
 *   batch of a version at the same time both land in the one row instead of one failing on the
 *   unique index;
 * - the row is then locked (`FOR UPDATE`) before its status is checked, so a finalize cannot
 *   change it between the check and the insert, and concurrent submits to the same version
 *   take turns;
 * - the samples and the sample count increment commit together.
 */
export function submitSamples(
  db: CorpusDb,
  agent: { id: string; tenantId: string },
  { corpusVersion, samples }: CorpusSubmission
): Promise<SubmitOutcome> {
  return db.$transaction(async (tx) => {
    const version = await lockVersion(tx, agent.tenantId, corpusVersion);
    if (version.status !== "collecting") {
      return { outcome: "notCollecting", status: version.status };
    }

    await tx.corpusSample.createMany({
      data: samples.map((sample) => ({
        tenantId: agent.tenantId,
        corpusVersionId: version.id,
        agentId: agent.id,
        timestamp: new Date(sample.timestamp),
        eventType: sample.eventType,
        event: sample.event,
      })),
    });
    const { sampleCount } = await tx.corpusVersion.update({
      where: { id: version.id },
      data: { sampleCount: { increment: samples.length } },
      select: { sampleCount: true },
    });
    return { outcome: "accepted", totalSamples: sampleCount };
  });
}

/** The tenant's version `version`, created empty and collecting if missing, locked for `tx`. */
async function lockVersion(
  tx: Prisma.TransactionClient,
  tenantId: string,
  version: number
): Promise<{ id: string; status: string }> {
  await tx.corpusVersion.createMany({
    data: [{ tenantId, version, sampleCount: 0, status: "collecting", collectionStart: new Date() }],
    skipDuplicates: true,
  });
  const [row] = await tx.$queryRaw<{ id: string; status: string }[]>`
    SELECT id, status FROM corpus_versions
    WHERE tenant_id = ${tenantId} AND version = ${version}
    FOR UPDATE`;
  return row;
}
