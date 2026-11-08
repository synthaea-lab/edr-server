import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  cleanDatabase,
  createTestAgent,
  createTestCase,
  createTestDetection,
  createTestTenant,
  prisma,
} from "../helpers/db";

/**
 * Database constraints and defaults `prisma/schema.prisma` declares and the routes rely on
 * without checking themselves. These exercise the schema, not a route: route behavior is
 * tested against the handlers in the other files.
 */
describe("schema constraints (real database)", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await cleanDatabase();
    await prisma.$disconnect();
  });

  it("puts a new agent in the prod ring", async () => {
    const tenant = await createTestTenant();

    const agent = await prisma.agent.create({
      data: { tenantId: tenant.id, enrollmentId: "agent-default-ring", lastSeen: new Date() },
    });

    expect(agent.ring).toBe("prod");
  });

  it("keeps enrollment ids unique across tenants", async () => {
    const tenant1 = await createTestTenant();
    const tenant2 = await createTestTenant();
    await createTestAgent(tenant1.id, "duplicate-agent");

    await expect(createTestAgent(tenant2.id, "duplicate-agent")).rejects.toMatchObject({ code: "P2002" });
  });

  it("keeps a detection's ingest id unique per agent while allowing any number without one", async () => {
    const tenant = await createTestTenant();
    const firstAgent = await createTestAgent(tenant.id);
    const secondAgent = await createTestAgent(tenant.id);
    const key = "b9628fc1-2134-4d4d-bbe6-83fdd1929d7a";
    const data = {
      tenantId: tenant.id,
      timestamp: new Date(),
      technique: "T1059",
      severity: "medium",
      event: {},
      meta: {},
    };

    await prisma.detection.create({ data: { ...data, agentId: firstAgent.id, ingestId: key } });
    await expect(
      prisma.detection.create({ data: { ...data, agentId: firstAgent.id, ingestId: key } })
    ).rejects.toMatchObject({ code: "P2002" });
    await prisma.detection.create({ data: { ...data, agentId: secondAgent.id, ingestId: key } });
    await prisma.detection.create({ data: { ...data, agentId: firstAgent.id } });
    await prisma.detection.create({ data: { ...data, agentId: firstAgent.id } });
  });

  it("keeps one content release per tenant, ring and version, active by default", async () => {
    const tenant = await createTestTenant();
    const release = {
      tenantId: tenant.id,
      ring: "canary_0",
      releaseVersion: 1,
      manifestUrl: "https://example.com/manifest-v1.json",
      manifestSha256: "a".repeat(64),
      releasedAt: new Date(),
    };

    expect((await prisma.contentRelease.create({ data: release })).status).toBe("active");
    await expect(
      prisma.contentRelease.create({ data: { ...release, manifestSha256: "b".repeat(64) } })
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("deletes a tenant's agents, detections and cases with the tenant", async () => {
    const tenant = await createTestTenant();
    const agent = await createTestAgent(tenant.id);
    await createTestDetection(tenant.id, agent.id);
    await createTestCase(tenant.id);

    await prisma.tenant.delete({ where: { id: tenant.id } });

    expect(await prisma.agent.count({ where: { tenantId: tenant.id } })).toBe(0);
    expect(await prisma.detection.count({ where: { tenantId: tenant.id } })).toBe(0);
    expect(await prisma.case.count({ where: { tenantId: tenant.id } })).toBe(0);
  });
});
