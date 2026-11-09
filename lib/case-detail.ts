import type { CaseNarrative, PrismaClient } from "@prisma/client";
import type { NarrativeCitation } from "@/lib/case-narrative";
import { citationsOf } from "@/lib/case-narrative";
import {
  getPrevalenceBatch,
  lookedUpKeys,
  observationsOfDetections,
  prevalenceKey,
  triageLines,
} from "@/lib/prevalence";

/**
 * Reading one case for the console page and `GET /api/cases/[id]`: the case, its detections
 * (newest first), its latest narrative and the fleet triage lines of each detection. Scoped to
 * the tenant, so another tenant's case is "not found". Server only.
 */

type CaseDetailDb = Pick<PrismaClient, "case" | "caseNarrative" | "prevalenceSighting">;

type CaseWithDetections = NonNullable<Awaited<ReturnType<typeof findCase>>>;

export type CaseDetailDetection = CaseWithDetections["detections"][number];

/**
 * The latest narrative, with `stale` derived (not stored): true when a detection was attached to
 * the case after the narrative was generated.
 */
export type CaseDetailNarrative = Omit<CaseNarrative, "citations"> & {
  citations: NarrativeCitation[];
  stale: boolean;
};

export type CaseDetail = {
  case: Omit<CaseWithDetections, "detections">;
  detections: CaseDetailDetection[];
  narrative: CaseDetailNarrative | null;
  /** Per detection id: "seen on N hosts, first <date>" for what its event touched (issue #76). */
  prevalence: Record<string, ReturnType<typeof triageLines>>;
};

function findCase(db: CaseDetailDb, tenantId: string, caseId: string) {
  return db.case.findFirst({
    where: { id: caseId, tenantId },
    include: { detections: { orderBy: { timestamp: "desc" } } },
  });
}

/** The case `caseId` of `tenantId`, or null when the tenant has no such case. */
export async function loadCaseDetail(
  db: CaseDetailDb,
  tenantId: string,
  caseId: string
): Promise<CaseDetail | null> {
  const found = await findCase(db, tenantId, caseId);
  if (!found) return null;
  const { detections, ...caseFields } = found;

  const latest = await db.caseNarrative.findFirst({
    where: { caseId: found.id },
    orderBy: { generatedAt: "desc" },
  });
  const narrative = latest
    ? {
        ...latest,
        citations: citationsOf(latest.citations),
        stale: detections.some((d) => d.updatedAt > latest.generatedAt),
      }
    : null;

  return { case: caseFields, detections, narrative, prevalence: await prevalenceOf(db, tenantId, detections) };
}

/** One grouped prevalence lookup for the whole case, not one per detection. */
async function prevalenceOf(
  db: Pick<PrismaClient, "prevalenceSighting">,
  tenantId: string,
  detections: CaseDetailDetection[]
): Promise<CaseDetail["prevalence"]> {
  const observations = observationsOfDetections(detections);
  const found = await getPrevalenceBatch(db, tenantId, observations);
  const lookedUp = new Set(lookedUpKeys(observations).map((o) => prevalenceKey(o.kind, o.key)));
  return Object.fromEntries(
    detections.map((d) => [d.id, triageLines(observationsOfDetections([d]), found, lookedUp)])
  );
}
