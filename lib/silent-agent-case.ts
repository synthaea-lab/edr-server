import type { PrismaClient } from "@prisma/client";

/**
 * The case the silent-agent cron opens for an agent that stopped heartbeating, and how it is
 * found again. The case has no column naming its agent, so the text is the link: the title
 * starts with `Agent Silent:` and the description always ends with the agent's enrollment id,
 * which is unique per agent. The title carries the host name when there is one, so it cannot
 * be searched by agent id (#901). The cron reads this to open at most one case per agent, the
 * host-transition notifier to link the case from a `host.silent` message.
 */

const TITLE_PREFIX = "Agent Silent: ";
const ENROLLMENT_MARK = "Enrollment ID: ";

type SilentAgent = { id: string; hostname: string | null; enrollmentId: string; lastSeen: Date };

export function silentCaseTitle(agent: Pick<SilentAgent, "id" | "hostname">): string {
  return `${TITLE_PREFIX}${agent.hostname || agent.id}`;
}

export function silentCaseDescription(agent: Pick<SilentAgent, "enrollmentId" | "lastSeen">): string {
  return `Agent has not sent heartbeat for >5 minutes. Last seen: ${agent.lastSeen.toISOString()}. ${ENROLLMENT_MARK}${agent.enrollmentId}`;
}

/** The enrollment id a silent-agent case was opened for, read back from its description. */
function enrollmentIdOf(description: string | null): string | null {
  if (description === null) return null;
  const at = description.lastIndexOf(ENROLLMENT_MARK);
  return at < 0 ? null : description.slice(at + ENROLLMENT_MARK.length);
}

/**
 * The open silent-agent case of each of `enrollmentIds` in a tenant, in one query, keyed by
 * enrollment id. An agent with no open case is absent from the map; with several, the oldest
 * wins. The description must end with the id, so `enr-1` does not match the case of `enr-10`.
 */
export async function findOpenSilentCases(
  db: Pick<PrismaClient, "case">,
  tenantId: string,
  enrollmentIds: readonly string[]
): Promise<Map<string, { id: string }>> {
  const found = new Map<string, { id: string }>();
  if (enrollmentIds.length === 0) return found;

  const cases = await db.case.findMany({
    where: {
      tenantId,
      status: "open",
      title: { startsWith: TITLE_PREFIX },
      OR: enrollmentIds.map((id) => ({ description: { endsWith: `${ENROLLMENT_MARK}${id}` } })),
    },
    select: { id: true, description: true },
    orderBy: { createdAt: "asc" },
  });

  const wanted = new Set(enrollmentIds);
  for (const c of cases) {
    const enrollmentId = enrollmentIdOf(c.description);
    if (enrollmentId !== null && wanted.has(enrollmentId) && !found.has(enrollmentId)) {
      found.set(enrollmentId, { id: c.id });
    }
  }
  return found;
}
