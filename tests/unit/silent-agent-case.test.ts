import { describe, expect, it, vi } from "vitest";
import {
  findOpenSilentCases,
  silentCaseDescription,
  silentCaseTitle,
} from "@/lib/silent-agent-case";

const lastSeen = new Date("2026-10-19T10:00:00Z");

describe("silent-agent case text", () => {
  // These strings are stored in existing cases and read back by `findOpenSilentCases`.
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

describe("findOpenSilentCases", () => {
  const fakeDb = (rows: { id: string; description: string | null }[]) => {
    const findMany = vi.fn(async () => rows);
    return { db: { case: { findMany } } as never, findMany };
  };

  it("does not query when there is nothing to look up", async () => {
    const { db, findMany } = fakeDb([]);
    expect((await findOpenSilentCases(db, "t-1", [])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("asks once for every enrollment id, open silent-agent cases of the tenant only", async () => {
    const { db, findMany } = fakeDb([]);
    await findOpenSilentCases(db, "t-1", ["enr-1", "enr-2"]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        tenantId: "t-1",
        status: "open",
        title: { startsWith: "Agent Silent: " },
        OR: [
          { description: { endsWith: "Enrollment ID: enr-1" } },
          { description: { endsWith: "Enrollment ID: enr-2" } },
        ],
      },
      select: { id: true, description: true },
      orderBy: { createdAt: "asc" },
    });
  });

  it("keys the cases by enrollment id, keeps the oldest and ignores ids not asked for", async () => {
    const d = (enrollmentId: string) => silentCaseDescription({ enrollmentId, lastSeen });
    const { db } = fakeDb([
      { id: "c-old", description: d("enr-1") },
      { id: "c-new", description: d("enr-1") },
      { id: "c-10", description: d("enr-10") },
      { id: "c-none", description: null },
    ]);
    const found = await findOpenSilentCases(db, "t-1", ["enr-1", "enr-2"]);
    expect(Object.fromEntries(found)).toEqual({ "enr-1": { id: "c-old" } });
  });
});
