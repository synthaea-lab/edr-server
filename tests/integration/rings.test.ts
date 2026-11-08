import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { cleanDatabase, createTestAgent, createTestMember, createTestTenant, prisma } from "../helpers/db";
import { createTenantHeaders } from "../helpers/http";
import { POST as assignRing } from "@/app/api/agents/[agentId]/ring/route";
import { GET as ringAgents } from "@/app/api/rings/[ring]/agents/route";
import { GET as ringHealth } from "@/app/api/rings/[ring]/health/route";

const minutesAgo = (n: number) => new Date(Date.now() - n * 60 * 1000);

const assign = (caller: { tenantId: string; userId: string }, agentId: string, ring: string) =>
  assignRing(
    new NextRequest(`http://localhost/api/agents/${agentId}/ring`, {
      method: "POST",
      headers: createTenantHeaders(caller.tenantId, caller.userId),
      body: JSON.stringify({ ring }),
    }),
    { params: { agentId } }
  );

const getRingAgents = (tenantId: string, ring: string, query = "") =>
  ringAgents(
    new NextRequest(`http://localhost/api/rings/${ring}/agents${query}`, { headers: createTenantHeaders(tenantId) }),
    { params: { ring } }
  );

async function enrollmentIdsIn(tenantId: string, ring: string, query = "") {
  const res = await getRingAgents(tenantId, ring, query);
  expect(res.status).toBe(200);
  return ((await res.json()).agents as { enrollmentId: string }[]).map((a) => a.enrollmentId).sort();
}

describe("Canary rings (real database)", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await cleanDatabase();
    await prisma.$disconnect();
  });

  describe("POST /api/agents/[agentId]/ring", () => {
    it("moves an agent to another ring and audits the move", async () => {
      const admin = await createTestMember();
      const agent = await createTestAgent(admin.tenantId, "agent-1");

      const res = await assign(admin, agent.id, "canary_0");

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "ok", previousRing: "prod" });
      expect(await enrollmentIdsIn(admin.tenantId, "canary_0")).toEqual(["agent-1"]);
      expect(
        await prisma.auditLog.count({ where: { tenantId: admin.tenantId, action: "agent.ring.assignment" } })
      ).toBe(1);
    });

    it("answers 404 for another tenant's agent and leaves it in its ring", async () => {
      const admin = await createTestMember();
      const other = await createTestTenant();
      const theirs = await createTestAgent(other.id, "agent-other");

      const res = await assign(admin, theirs.id, "canary_0");

      expect(res.status).toBe(404);
      expect((await prisma.agent.findUniqueOrThrow({ where: { id: theirs.id } })).ring).toBe("prod");
    });
  });

  describe("GET /api/rings/[ring]/agents", () => {
    it("lists the agents of one ring", async () => {
      const tenant = await createTestTenant();
      await createTestAgent(tenant.id, "agent-prod-1", { ring: "prod" });
      await createTestAgent(tenant.id, "agent-prod-2", { ring: "prod" });
      await createTestAgent(tenant.id, "agent-canary-1", { ring: "canary_0" });
      await createTestAgent(tenant.id, "agent-canary-2", { ring: "canary_1" });

      expect(await enrollmentIdsIn(tenant.id, "prod")).toEqual(["agent-prod-1", "agent-prod-2"]);
      expect(await enrollmentIdsIn(tenant.id, "canary_0")).toEqual(["agent-canary-1"]);
    });

    it("lists only the caller's tenant's agents", async () => {
      const tenant1 = await createTestTenant("Tenant A");
      const tenant2 = await createTestTenant("Tenant B");
      await createTestAgent(tenant1.id, "agent-a", { ring: "canary_0" });
      await createTestAgent(tenant2.id, "agent-b", { ring: "canary_0" });

      expect(await enrollmentIdsIn(tenant1.id, "canary_0")).toEqual(["agent-a"]);
      expect(await enrollmentIdsIn(tenant2.id, "canary_0")).toEqual(["agent-b"]);
    });

    it("splits healthy from silent agents at five minutes", async () => {
      const tenant = await createTestTenant();
      await createTestAgent(tenant.id, "agent-fresh", { ring: "canary_0", lastSeen: minutesAgo(1) });
      await createTestAgent(tenant.id, "agent-silent", { ring: "canary_0", lastSeen: minutesAgo(10) });

      expect(await enrollmentIdsIn(tenant.id, "canary_0", "?status=healthy")).toEqual(["agent-fresh"]);
      expect(await enrollmentIdsIn(tenant.id, "canary_0", "?status=silent")).toEqual(["agent-silent"]);
    });

    it("refuses an unknown ring with 400", async () => {
      const tenant = await createTestTenant();

      expect((await getRingAgents(tenant.id, "canary_9")).status).toBe(400);
    });
  });

  describe("GET /api/rings/[ring]/health", () => {
    it("counts healthy and silent agents in the ring", async () => {
      const tenant = await createTestTenant();
      await createTestAgent(tenant.id, "agent-healthy-1", { ring: "canary_0", lastSeen: new Date() });
      await createTestAgent(tenant.id, "agent-healthy-2", { ring: "canary_0", lastSeen: minutesAgo(4) });
      await createTestAgent(tenant.id, "agent-silent-1", { ring: "canary_0", lastSeen: minutesAgo(10) });
      await createTestAgent(tenant.id, "agent-elsewhere", { ring: "prod", lastSeen: minutesAgo(10) });

      const res = await ringHealth(
        new NextRequest("http://localhost/api/rings/canary_0/health", { headers: createTenantHeaders(tenant.id) }),
        { params: { ring: "canary_0" } }
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ring: "canary_0",
        totalAgents: 3,
        healthyAgents: 2,
        silentAgents: 1,
        silentRate: 0.33,
        healthStatus: "unhealthy",
      });
    });
  });
});
