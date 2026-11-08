import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { cleanDatabase, createTestAgent, createTestMember, createTestTenant, prisma } from "../helpers/db";
import { createTenantHeaders } from "../helpers/http";
import { POST as enroll } from "@/app/api/enrollment/route";

function enrollRequest(
  caller: { tenantId: string; userId: string },
  body: unknown = { enrollmentId: "new-agent-001", hostname: "test-vm-01", version: "0.1.0" }
) {
  return new NextRequest("http://localhost/api/enrollment", {
    method: "POST",
    headers: createTenantHeaders(caller.tenantId, caller.userId),
    body: JSON.stringify(body),
  });
}

describe("POST /api/enrollment (real database)", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await cleanDatabase();
    await prisma.$disconnect();
  });

  it("enrolls a new agent under the caller's tenant, in the prod ring, and audits it", async () => {
    const admin = await createTestMember("admin");

    const res = await enroll(enrollRequest(admin));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "enrolled", ring: "prod" });
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: body.agentId } });
    expect(agent).toMatchObject({
      tenantId: admin.tenantId,
      enrollmentId: "new-agent-001",
      hostname: "test-vm-01",
      version: "0.1.0",
    });
    const audit = await prisma.auditLog.findMany({
      where: { tenantId: admin.tenantId, action: "enrollment.create" },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ userId: admin.userId, resource: `agents/${agent.id}` });
  });

  it("answers already_enrolled for an enrollment id of the caller's tenant, adding no second agent", async () => {
    const admin = await createTestMember();
    const existing = await createTestAgent(admin.tenantId, "duplicate-agent", { ring: "canary_1" });

    const res = await enroll(enrollRequest(admin, { enrollmentId: "duplicate-agent" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "already_enrolled", agentId: existing.id, ring: "canary_1" });
    expect(await prisma.agent.count({ where: { enrollmentId: "duplicate-agent" } })).toBe(1);
  });

  it("refuses with 409 an enrollment id another tenant's agent holds, leaving that agent as it was", async () => {
    const admin = await createTestMember();
    const other = await createTestTenant();
    const theirs = await createTestAgent(other.id, "taken-agent");

    const res = await enroll(enrollRequest(admin, { enrollmentId: "taken-agent" }));

    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).not.toContain(theirs.id);
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({
      tenantId: other.id,
    });
  });

  it("refuses a plain member with 403 and enrolls nothing", async () => {
    const member = await createTestMember("member");

    const res = await enroll(enrollRequest(member));

    expect(res.status).toBe(403);
    expect(await prisma.agent.count()).toBe(0);
  });

  it("refuses a malformed payload with 400", async () => {
    const admin = await createTestMember();

    const res = await enroll(enrollRequest(admin, { hostname: "no-enrollment-id" }));

    expect(res.status).toBe(400);
    expect(await prisma.agent.count()).toBe(0);
  });
});
