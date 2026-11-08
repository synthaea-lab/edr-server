import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Route logic runs against a mocked Prisma client, so these need no database.
const db = vi.hoisted(() => ({
  agent: { findUnique: vi.fn(), create: vi.fn() },
  auditLog: { create: vi.fn() },
  member: { findFirst: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

import { POST as enroll } from "@/app/api/enrollment/route";

function enrollReq(body: unknown = { enrollmentId: "e1", hostname: "h1", version: "0.1.0" }) {
  return new NextRequest("http://localhost/api/enrollment", {
    method: "POST",
    headers: { "x-tenant-id": "t1", "x-user-id": "u1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.member.findFirst.mockResolvedValue({ role: "admin" });
  db.agent.findUnique.mockResolvedValue(null);
  db.agent.create.mockImplementation(async ({ data }) => ({ id: "a-new", ring: "canary_0", ...data }));
  db.auditLog.create.mockResolvedValue({});
});

describe("POST /api/enrollment", () => {
  it("refuses an enrollment id enrolled under another tenant with 409, disclosing nothing of that agent", async () => {
    db.agent.findUnique.mockResolvedValue({ id: "a-other", tenantId: "t2", ring: "prod", enrollmentId: "e1" });

    const res = await enroll(enrollReq());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(JSON.stringify(body)).not.toContain("a-other");
    expect(JSON.stringify(body)).not.toContain("prod");
    expect(body).not.toHaveProperty("agentId");
    expect(body).not.toHaveProperty("ring");
    expect(db.agent.create).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("reports an enrollment id already enrolled under the caller's own tenant as already_enrolled", async () => {
    db.agent.findUnique.mockResolvedValue({ id: "a1", tenantId: "t1", ring: "canary_1", enrollmentId: "e1" });

    const res = await enroll(enrollReq());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "already_enrolled", agentId: "a1", ring: "canary_1" });
    expect(db.agent.create).not.toHaveBeenCalled();
  });

  it("enrolls a new agent under the caller's tenant and audits it under the caller's id", async () => {
    const res = await enroll(enrollReq());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "enrolled", agentId: "a-new", ring: "canary_0" });
    expect(db.agent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: "t1", enrollmentId: "e1", hostname: "h1", version: "0.1.0" }),
    });
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: "t1", userId: "u1", action: "enrollment.create" }),
      })
    );
  });

  it("refuses a plain member with 403 before reading the body or touching any agent", async () => {
    db.member.findFirst.mockResolvedValue({ role: "member" });

    expect((await enroll(enrollReq({ enrollmentId: 42 }))).status).toBe(403);
    expect((await enroll(enrollReq())).status).toBe(403);
    expect(db.agent.findUnique).not.toHaveBeenCalled();
    expect(db.agent.create).not.toHaveBeenCalled();
  });

  it("refuses a caller with no membership row in the tenant with 403", async () => {
    db.member.findFirst.mockResolvedValue(null);

    expect((await enroll(enrollReq())).status).toBe(403);
    expect(db.agent.findUnique).not.toHaveBeenCalled();
  });

  it("looks the membership up by the caller's own tenant and user id", async () => {
    await enroll(enrollReq());

    expect(db.member.findFirst).toHaveBeenCalledWith({
      where: { organizationId: "t1", userId: "u1" },
      select: { role: true },
    });
  });
});
