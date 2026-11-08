import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import {
  cleanDatabase,
  createTestAgent,
  createTestCase,
  createTestDetection,
  createTestTenant,
  prisma,
} from "../helpers/db";
import { createTenantHeaders } from "../helpers/http";
import { GET as getAgent } from "@/app/api/agents/[agentId]/route";
import { GET as listCases } from "@/app/api/cases/route";
import { GET as getCase } from "@/app/api/cases/[id]/route";
import { GET as ringHealth } from "@/app/api/rings/[ring]/health/route";

/** A request carrying `tenantId` as the session's tenant, the way middleware forwards it. */
const asTenant = (tenantId: string, path: string) =>
  new NextRequest(`http://localhost${path}`, { headers: createTenantHeaders(tenantId) });

describe("Tenancy isolation through the routes (real database)", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await cleanDatabase();
    await prisma.$disconnect();
  });

  it("answers 404 for another tenant's agent", async () => {
    const mine = await createTestTenant("Tenant A");
    const other = await createTestTenant("Tenant B");
    const theirs = await createTestAgent(other.id);

    const res = await getAgent(asTenant(mine.id, `/api/agents/${theirs.id}`), { params: { agentId: theirs.id } });

    expect(res.status).toBe(404);
  });

  it("answers 404 for another tenant's case, and leaves it out of the case list", async () => {
    const mine = await createTestTenant("Tenant A");
    const other = await createTestTenant("Tenant B");
    const myCase = await createTestCase(mine.id);
    const theirCase = await createTestCase(other.id);

    const detail = await getCase(asTenant(mine.id, `/api/cases/${theirCase.id}`), { params: { id: theirCase.id } });
    const list = await listCases(asTenant(mine.id, "/api/cases"));

    expect(detail.status).toBe(404);
    expect(((await list.json()).cases as { id: string }[]).map((c) => c.id)).toEqual([myCase.id]);
  });

  it("counts only the caller's tenant's agents and detections in ring health", async () => {
    const mine = await createTestTenant("Tenant A");
    const other = await createTestTenant("Tenant B");
    const myAgent = await createTestAgent(mine.id);
    const theirAgent = await createTestAgent(other.id);
    await createTestDetection(mine.id, myAgent.id);
    await createTestDetection(mine.id, myAgent.id);
    await createTestDetection(other.id, theirAgent.id);

    const res = await ringHealth(asTenant(mine.id, "/api/rings/prod/health"), { params: { ring: "prod" } });

    expect(await res.json()).toMatchObject({ totalAgents: 1, recentDetections: 2 });
  });
});
