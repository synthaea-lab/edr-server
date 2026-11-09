import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { cleanDatabase, createTestTenant, createTestAgent, prisma } from "../helpers/db";
import { GET } from "@/app/api/cron/detect-silent-agents/route";

function cronRequest() {
  return new NextRequest("http://localhost/api/cron/detect-silent-agents", {
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
}

const HOUR_AGO = () => new Date(Date.now() - 60 * 60 * 1000);

describe("GET /api/cron/detect-silent-agents", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await cleanDatabase();
    await prisma.$disconnect();
  });

  it("opens one case per silent agent, however many times it runs (#901)", async () => {
    const tenant = await createTestTenant();
    // `createTestAgent` gives every agent a host name, which the case title then carries.
    await createTestAgent(tenant.id, "enroll-named", { hostname: "web-01", lastSeen: HOUR_AGO() });
    await prisma.agent.create({
      data: { tenantId: tenant.id, enrollmentId: "enroll-unnamed", lastSeen: HOUR_AGO() },
    });

    const created: number[] = [];
    for (let run = 0; run < 3; run++) {
      const res = await GET(cronRequest());
      expect(res.status).toBe(200);
      created.push((await res.json()).casesCreated);
    }

    expect(created).toEqual([2, 0, 0]);
    const titles = (await prisma.case.findMany({ where: { tenantId: tenant.id } }))
      .map((c) => c.title)
      .sort();
    expect(titles).toHaveLength(2);
    expect(titles.filter((t) => t === "Agent Silent: web-01")).toHaveLength(1);
  });

  it("leaves an agent seen within the last five minutes alone", async () => {
    const tenant = await createTestTenant();
    await createTestAgent(tenant.id, "enroll-silent", { lastSeen: new Date(Date.now() - 6 * 60 * 1000) });
    await createTestAgent(tenant.id, "enroll-active", { lastSeen: new Date(Date.now() - 1 * 60 * 1000) });

    const res = await GET(cronRequest());

    expect(await res.json()).toMatchObject({ silentAgents: 1, casesCreated: 1 });
    expect(await prisma.case.count({ where: { tenantId: tenant.id } })).toBe(1);
  });

  it("opens a new case once the previous one is resolved", async () => {
    const tenant = await createTestTenant();
    await createTestAgent(tenant.id, "enroll-named", { hostname: "web-01", lastSeen: HOUR_AGO() });

    await GET(cronRequest());
    await prisma.case.updateMany({ where: { tenantId: tenant.id }, data: { status: "resolved" } });
    const res = await GET(cronRequest());

    expect((await res.json()).casesCreated).toBe(1);
    expect(await prisma.case.count({ where: { tenantId: tenant.id } })).toBe(2);
  });

  it("keeps each tenant's and each agent's case apart, even when one enrollment id prefixes another", async () => {
    const a = await createTestTenant();
    const b = await createTestTenant();
    await createTestAgent(a.id, "enr-1", { hostname: "web-01", lastSeen: HOUR_AGO() });
    await createTestAgent(a.id, "enr-10", { hostname: "web-10", lastSeen: HOUR_AGO() });
    await createTestAgent(b.id, "enr-2", { hostname: "web-01", lastSeen: HOUR_AGO() });

    // Only enr-10 has an open case: it must not count as enr-1's.
    await GET(cronRequest());
    await prisma.case.updateMany({
      where: { tenantId: a.id, title: "Agent Silent: web-01" },
      data: { status: "resolved" },
    });
    const res = await GET(cronRequest());

    expect((await res.json()).casesCreated).toBe(1);
    const open = await prisma.case.findMany({ where: { status: "open" }, select: { tenantId: true, title: true } });
    expect(open.map((c) => `${c.tenantId === a.id ? "a" : "b"} ${c.title}`).sort()).toEqual([
      "a Agent Silent: web-01",
      "a Agent Silent: web-10",
      "b Agent Silent: web-01",
    ]);
  });
});
