import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { cleanDatabase, createTestAgent, createTestCase, createTestTenant, prisma } from "../helpers/db";
import { createTenantHeaders } from "../helpers/http";
import { GET as listCases } from "@/app/api/cases/route";
import { GET as getAgent } from "@/app/api/agents/[agentId]/route";
import { GET as listRingAgents } from "@/app/api/rings/[ring]/agents/route";

// Characterization tests for three older tenant-scoped read routes. They pin today's answers,
// so the query-parameter validation (SV-016, SV-024) and the typed tenant guard (SV-004) can
// change them on purpose. Assertions marked "current behavior" pin answers those items are
// expected to change.

const MINUTE = 60 * 1000;

const casesReq = (query: string, headers: Record<string, string>) =>
  listCases(new NextRequest(`http://localhost/api/cases${query}`, { headers }));

const agentReq = (agentId: string, headers: Record<string, string>) =>
  getAgent(new NextRequest(`http://localhost/api/agents/${agentId}`, { headers }), { params: { agentId } });

const ringAgentsReq = (ring: string, query: string, headers: Record<string, string>) =>
  listRingAgents(new NextRequest(`http://localhost/api/rings/${ring}/agents${query}`, { headers }), {
    params: { ring },
  });

const titles = (body: { cases: { title: string }[] }) => body.cases.map((c) => c.title);

afterAll(async () => {
  await cleanDatabase();
  await prisma.$disconnect();
});

describe("GET /api/cases", () => {
  beforeEach(cleanDatabase);

  it("lists only the caller's tenant's cases, newest first", async () => {
    const tenant = await createTestTenant();
    const other = await createTestTenant();
    await createTestCase(tenant.id, { title: "older" });
    await createTestCase(tenant.id, { title: "newer" });
    await createTestCase(other.id, { title: "foreign" });
    // `createdAt` defaults to now(); make the order explicit rather than rely on insert timing.
    await prisma.case.updateMany({ where: { title: "older" }, data: { createdAt: new Date(Date.now() - MINUTE) } });

    const res = await casesReq("", createTenantHeaders(tenant.id));

    expect(res.status).toBe(200);
    expect(titles(await res.json())).toEqual(["newer", "older"]);
  });

  it("filters by status and severity together, and honours limit", async () => {
    const tenant = await createTestTenant();
    await createTestCase(tenant.id, { title: "open-high", status: "open", severity: "high" });
    await createTestCase(tenant.id, { title: "open-low", status: "open", severity: "low" });
    await createTestCase(tenant.id, { title: "resolved-high", status: "resolved", severity: "high" });

    const filtered = await (await casesReq("?status=open&severity=high", createTenantHeaders(tenant.id))).json();
    const limited = await (await casesReq("?limit=2", createTenantHeaders(tenant.id))).json();

    expect(titles(filtered)).toEqual(["open-high"]);
    expect(limited.cases).toHaveLength(2);
  });

  it("answers an unknown filter value with an empty list", async () => {
    const tenant = await createTestTenant();
    await createTestCase(tenant.id);

    const res = await casesReq("?severity=bogus", createTenantHeaders(tenant.id));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cases: [] });
  });

  it("answers a non-numeric limit with the default-sized list, not a 500 (SV-016)", async () => {
    const tenant = await createTestTenant();

    const res = await casesReq("?limit=abc", createTenantHeaders(tenant.id));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cases: [] });
  });

  it("answers a caller with no tenant context with 401 (SV-004)", async () => {
    const res = await casesReq("", {});

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
  });
});

describe("GET /api/agents/[agentId]", () => {
  beforeEach(cleanDatabase);

  it("returns the agent with its tenant's id and name", async () => {
    const tenant = await createTestTenant();
    const agent = await createTestAgent(tenant.id, "e-detail", { ring: "canary_1", hostname: "web-01" });

    const res = await agentReq(agent.id, createTenantHeaders(tenant.id));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.agent).toMatchObject({
      id: agent.id,
      tenantId: tenant.id,
      enrollmentId: "e-detail",
      hostname: "web-01",
      ring: "canary_1",
      tenant: { id: tenant.id, name: tenant.name },
    });
    expect(Object.keys(body.agent.tenant).sort()).toEqual(["id", "name"]);
  });

  it("answers 404 for another tenant's agent, as for an unknown id", async () => {
    const tenant = await createTestTenant();
    const other = await createTestTenant();
    const foreign = await createTestAgent(other.id, "e-foreign");

    const foreignRes = await agentReq(foreign.id, createTenantHeaders(tenant.id));
    const unknownRes = await agentReq("00000000-0000-0000-0000-000000000000", createTenantHeaders(tenant.id));

    expect(foreignRes.status).toBe(404);
    expect(await foreignRes.json()).toEqual({ error: "Agent not found" });
    expect(unknownRes.status).toBe(404);
  });

  it("answers a caller with no tenant context with 401 (SV-004)", async () => {
    const res = await agentReq("any", {});

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
  });
});

describe("GET /api/rings/[ring]/agents", () => {
  beforeEach(cleanDatabase);

  it("refuses an unknown ring with 400 and the valid rings", async () => {
    const tenant = await createTestTenant();

    const res = await ringAgentsReq("canary_9", "", createTenantHeaders(tenant.id));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid ring",
      validRings: ["canary_0", "canary_1", "canary_2", "prod"],
    });
  });

  it("lists the tenant's agents of that ring, most recently seen first, with the public fields", async () => {
    const tenant = await createTestTenant();
    const other = await createTestTenant();
    await createTestAgent(tenant.id, "e-old", { ring: "canary_0", lastSeen: new Date(Date.now() - 2 * MINUTE) });
    await createTestAgent(tenant.id, "e-new", { ring: "canary_0", lastSeen: new Date() });
    await createTestAgent(tenant.id, "e-prod", { ring: "prod" });
    await createTestAgent(other.id, "e-foreign", { ring: "canary_0" });

    const res = await ringAgentsReq("canary_0", "", createTenantHeaders(tenant.id));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ring).toBe("canary_0");
    expect(body.count).toBe(2);
    expect(body.agents.map((a: { enrollmentId: string }) => a.enrollmentId)).toEqual(["e-new", "e-old"]);
    expect(Object.keys(body.agents[0]).sort()).toEqual(
      ["createdAt", "enrollmentId", "hostname", "id", "lastSeen", "ring", "version"]
    );
  });

  it("splits healthy and silent agents at five minutes, and ignores an unknown status", async () => {
    const tenant = await createTestTenant();
    await createTestAgent(tenant.id, "e-healthy", { ring: "prod", lastSeen: new Date(Date.now() - 4 * MINUTE) });
    await createTestAgent(tenant.id, "e-silent", { ring: "prod", lastSeen: new Date(Date.now() - 6 * MINUTE) });
    const ids = async (query: string) =>
      (await (await ringAgentsReq("prod", query, createTenantHeaders(tenant.id))).json()).agents.map(
        (a: { enrollmentId: string }) => a.enrollmentId
      );

    expect(await ids("?status=healthy")).toEqual(["e-healthy"]);
    expect(await ids("?status=silent")).toEqual(["e-silent"]);
    expect(await ids("?status=bogus")).toEqual(["e-healthy", "e-silent"]);
    expect(await ids("?limit=1")).toEqual(["e-healthy"]);
  });

  it("answers a non-numeric limit with the default-sized list, not a 500 (SV-016)", async () => {
    const tenant = await createTestTenant();

    const res = await ringAgentsReq("prod", "?limit=abc", createTenantHeaders(tenant.id));

    expect(res.status).toBe(200);
    expect((await res.json()).agents).toEqual([]);
  });

  it("answers a caller with no tenant context with 401 (SV-004)", async () => {
    const res = await ringAgentsReq("prod", "", {});

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
  });
});
