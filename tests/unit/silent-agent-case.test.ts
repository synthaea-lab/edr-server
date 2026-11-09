import { describe, expect, it, vi } from "vitest";
import {
  caseNamesAgent,
  findOpenCasesNamingAgents,
  findOpenSilentCases,
  silentCaseDescription,
  silentCaseTitle,
} from "@/lib/silent-agent-case";

const lastSeen = new Date("2026-10-19T10:00:00Z");
const d = (enrollmentId: string) => silentCaseDescription({ enrollmentId, lastSeen });

describe("silent-agent case text", () => {
  // These strings are stored in existing cases and searched by both lookups below.
  it("titles the case by host name, or by agent id when the host has none", () => {
    expect(silentCaseTitle({ id: "a-1", hostname: "web-01" })).toBe("Agent Silent: web-01");
    expect(silentCaseTitle({ id: "a-1", hostname: null })).toBe("Agent Silent: a-1");
    expect(silentCaseTitle({ id: "a-1", hostname: "" })).toBe("Agent Silent: a-1");
  });

  it("ends the description with the enrollment id", () => {
    expect(silentCaseDescription({ enrollmentId: "enr-1", lastSeen })).toBe(
      "Agent has not sent heartbeat for >5 minutes. Last seen: 2026-10-19T10:00:00.000Z. Enrollment ID: enr-1"
    );
  });
});

const fakeDb = <T>(rows: T[]) => {
  const findMany = vi.fn(async () => rows);
  return { db: { case: { findMany } } as never, findMany };
};

describe("cron: findOpenCasesNamingAgents and caseNamesAgent", () => {
  const agent = { id: "a-1", enrollmentId: "enr-1" };

  it("does not query when there is nothing to look up", async () => {
    const { db, findMany } = fakeDb([]);
    expect(await findOpenCasesNamingAgents(db, "t-1", [])).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("asks once, with the cron's per-agent conditions joined by OR", async () => {
    const { db, findMany } = fakeDb([]);
    await findOpenCasesNamingAgents(db, "t-1", [agent, { id: "a-2", enrollmentId: "enr-2" }]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        tenantId: "t-1",
        status: "open",
        OR: [
          { title: { contains: "a-1" } },
          { description: { contains: "Enrollment ID: enr-1" } },
          { title: { contains: "a-2" } },
          { description: { contains: "Enrollment ID: enr-2" } },
        ],
      },
      select: { id: true, title: true, description: true },
    });
  });

  it("matches a case whose title contains the agent id, whatever kind of case it is", () => {
    expect(caseNamesAgent({ id: "c", title: "Lateral movement from a-1", description: null }, agent)).toBe(true);
  });

  it("matches a case whose description contains the enrollment mark", () => {
    expect(caseNamesAgent({ id: "c", title: "Agent Silent: web-01", description: d("enr-1") }, agent)).toBe(true);
    expect(caseNamesAgent({ id: "c", title: "Agent Silent: web-02", description: d("enr-2") }, agent)).toBe(false);
  });

  it("matches by substring, so enr-10's case counts for enr-1 (current behavior)", () => {
    expect(caseNamesAgent({ id: "c", title: "Agent Silent: web-10", description: d("enr-10") }, agent)).toBe(true);
  });
});

describe("notifier: findOpenSilentCases", () => {
  it("does not query when there is nothing to look up", async () => {
    const { db, findMany } = fakeDb([]);
    expect((await findOpenSilentCases(db, "t-1", [])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("asks once for every enrollment id, open `Agent Silent:` cases of the tenant only", async () => {
    const { db, findMany } = fakeDb([]);
    await findOpenSilentCases(db, "t-1", ["enr-1", "enr-2"]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        tenantId: "t-1",
        status: "open",
        title: { startsWith: "Agent Silent:" },
        OR: [
          { description: { contains: "Enrollment ID: enr-1" } },
          { description: { contains: "Enrollment ID: enr-2" } },
        ],
      },
      select: { id: true, description: true },
    });
  });

  it("keys the cases by enrollment id, takes the first row returned, and skips ids with none", async () => {
    const { db } = fakeDb([
      { id: "c-first", description: d("enr-1") },
      { id: "c-second", description: d("enr-1") },
      { id: "c-none", description: null },
    ]);
    const found = await findOpenSilentCases(db, "t-1", ["enr-1", "enr-2"]);
    expect(Object.fromEntries(found)).toEqual({ "enr-1": { id: "c-first" } });
  });

  it("matches by substring, so enr-10's case is found for enr-1 (current behavior)", async () => {
    const { db } = fakeDb([{ id: "c-10", description: d("enr-10") }]);
    const found = await findOpenSilentCases(db, "t-1", ["enr-1"]);
    expect(Object.fromEntries(found)).toEqual({ "enr-1": { id: "c-10" } });
  });
});
