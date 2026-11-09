import type { PrismaClient } from "@prisma/client";

/**
 * The case the silent-agent cron opens for an agent that stopped heartbeating, and how it is
 * found again. The case has no column naming its agent, so the text is the link: the title is
 * `Agent Silent: <host name or agent id>` and the description ends with `Enrollment ID: <id>`.
 * The title carries the host name when there is one, so it cannot be searched by agent id (#901).
 *
 * The cron and the host-transition notifier each search that text their own way, and both are
 * kept as they were: matching is `contains`/`startsWith`, exactly the Prisma filters each caller
 * used, so a lookup here finds the same cases the per-agent `findFirst` used to. Each lookup is
 * one query per tenant instead of one per agent.
 */

type SilentAgent = { id: string; hostname: string | null; enrollmentId: string; lastSeen: Date };

/** What a lookup reads back from a case to tell which agent it belongs to. */
export type CaseText = { id: string; title: string; description: string | null };

const enrollmentMark = (enrollmentId: string) => `Enrollment ID: ${enrollmentId}`;

export function silentCaseTitle(agent: Pick<SilentAgent, "id" | "hostname">): string {
  return `Agent Silent: ${agent.hostname || agent.id}`;
}

export function silentCaseDescription(agent: Pick<SilentAgent, "enrollmentId" | "lastSeen">): string {
  return `Agent has not sent heartbeat for >5 minutes. Last seen: ${agent.lastSeen.toISOString()}. ${enrollmentMark(agent.enrollmentId)}`;
}

/**
 * Whether an open case stops the cron from opening another one for `agent`: its title contains
 * the agent id, or its description contains the agent's enrollment mark. Both are substring
 * matches, as the cron has always done them (so `enr-10`'s case also counts for `enr-1`).
 */
export function caseNamesAgent(c: CaseText, agent: Pick<SilentAgent, "id" | "enrollmentId">): boolean {
  return c.title.includes(agent.id) || (c.description ?? "").includes(enrollmentMark(agent.enrollmentId));
}

/**
 * The open cases of a tenant that name any of `agents` (see `caseNamesAgent`), in one query.
 * The cron checks each agent against this list, and adds the cases it opens to it.
 */
export async function findOpenCasesNamingAgents(
  db: Pick<PrismaClient, "case">,
  tenantId: string,
  agents: readonly Pick<SilentAgent, "id" | "enrollmentId">[]
): Promise<CaseText[]> {
  if (agents.length === 0) return [];
  return db.case.findMany({
    where: {
      tenantId,
      status: "open",
      OR: agents.flatMap((a) => [
        { title: { contains: a.id } },
        { description: { contains: enrollmentMark(a.enrollmentId) } },
      ]),
    },
    select: { id: true, title: true, description: true },
  });
}

/**
 * The open silent-agent case of each of `enrollmentIds` in a tenant, in one query, keyed by
 * enrollment id: a case whose title starts with `Agent Silent:` and whose description contains
 * the enrollment mark. An agent with no such case is absent from the map. With several, the
 * first row returned wins; the query has no order, like the `findFirst` it replaces.
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
      title: { startsWith: "Agent Silent:" },
      OR: enrollmentIds.map((id) => ({ description: { contains: enrollmentMark(id) } })),
    },
    select: { id: true, description: true },
  });

  for (const enrollmentId of enrollmentIds) {
    const c = cases.find((row) => (row.description ?? "").includes(enrollmentMark(enrollmentId)));
    if (c) found.set(enrollmentId, { id: c.id });
  }
  return found;
}
