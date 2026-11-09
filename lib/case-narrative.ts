import { z } from "zod";
import type { Prisma } from "@prisma/client";

/**
 * One claim of a case narrative and the detection it cites (issue #50). The shape the LLM must
 * answer with, the shape stored in `CaseNarrative.citations` (a Json column) and the shape the
 * console and the API read back.
 */
export const NarrativeCitationSchema = z.object({
  detectionId: z.string(),
  claim: z.string(),
});

export type NarrativeCitation = z.infer<typeof NarrativeCitationSchema>;

const NarrativeCitationsSchema = z.array(NarrativeCitationSchema);

/** The stored form of a narrative's citations. */
export function citationsJson(citations: NarrativeCitation[]): Prisma.InputJsonValue {
  return citations;
}

/**
 * The citations stored on a narrative row. A value that is not a citation list (the column is
 * untyped Json) reads as no citations rather than as whatever it holds.
 */
export function citationsOf(stored: Prisma.JsonValue): NarrativeCitation[] {
  const parsed = NarrativeCitationsSchema.safeParse(stored);
  return parsed.success ? parsed.data : [];
}
