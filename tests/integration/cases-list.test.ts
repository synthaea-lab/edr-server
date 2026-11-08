import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { cleanDatabase, createTestCase, createTestTenant, prisma } from "../helpers/db";
import { createTenantHeaders } from "../helpers/http";
import { GET as listCases } from "@/app/api/cases/route";

async function casesOf(tenantId: string, query = "") {
  const res = await listCases(
    new NextRequest(`http://localhost/api/cases${query}`, { headers: createTenantHeaders(tenantId) })
  );
  expect(res.status).toBe(200);
  return (await res.json()).cases as { id: string; title: string; status: string; severity: string }[];
}

describe("GET /api/cases (real database)", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await cleanDatabase();
    await prisma.$disconnect();
  });

  it("returns only the caller's tenant's cases", async () => {
    const tenant1 = await createTestTenant("Tenant 1");
    const tenant2 = await createTestTenant("Tenant 2");
    await createTestCase(tenant1.id, { title: "Case 1" });
    await createTestCase(tenant1.id, { title: "Case 2" });
    await createTestCase(tenant2.id, { title: "Case 3" });

    const titles = (await casesOf(tenant1.id)).map((c) => c.title).sort();

    expect(titles).toEqual(["Case 1", "Case 2"]);
  });

  it("filters by status", async () => {
    const tenant = await createTestTenant();
    await createTestCase(tenant.id, { status: "open" });
    await createTestCase(tenant.id, { status: "open" });
    await createTestCase(tenant.id, { status: "resolved" });

    const cases = await casesOf(tenant.id, "?status=open");

    expect(cases).toHaveLength(2);
    expect(cases.every((c) => c.status === "open")).toBe(true);
  });

  it("filters by severity", async () => {
    const tenant = await createTestTenant();
    await createTestCase(tenant.id, { severity: "critical" });
    await createTestCase(tenant.id, { severity: "high" });
    await createTestCase(tenant.id, { severity: "medium" });

    const cases = await casesOf(tenant.id, "?severity=critical");

    expect(cases.map((c) => c.severity)).toEqual(["critical"]);
  });

  it("returns at most `limit` cases", async () => {
    const tenant = await createTestTenant();
    for (let i = 0; i < 10; i++) {
      await createTestCase(tenant.id, { title: `Case ${i}` });
    }

    expect(await casesOf(tenant.id, "?limit=5")).toHaveLength(5);
  });

  it("lists the newest case first", async () => {
    const tenant = await createTestTenant();
    const first = await createTestCase(tenant.id, { title: "First" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await createTestCase(tenant.id, { title: "Second" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const third = await createTestCase(tenant.id, { title: "Third" });

    expect((await casesOf(tenant.id)).map((c) => c.id)).toEqual([third.id, second.id, first.id]);
  });
});
