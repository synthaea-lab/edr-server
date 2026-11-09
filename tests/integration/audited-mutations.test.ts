import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { cleanDatabase, createTestTenant, prisma } from "../helpers/db";

// Fault injection: while `failAudit` is set, writing an audit row throws, as a failed insert
// would. The mutation it audits must then not be committed either.
const fault = vi.hoisted(() => ({ failAudit: false }));
vi.mock("@/lib/audit", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/audit")>();
  return {
    ...real,
    recordAudit: (...args: Parameters<typeof real.recordAudit>) => {
      if (fault.failAudit) throw new Error("injected audit failure");
      return real.recordAudit(...args);
    },
  };
});

// The publish routes check the manifest and artifacts in storage first; that is not what these
// tests are about, so both checks pass.
vi.mock("@/lib/content-publish", () => ({
  validatePublishable: async () => ({ ok: true, manifest: { entries: [{}] } }),
}));
vi.mock("@/lib/release-manifest", () => ({
  loadReleaseManifest: async () => ({ ok: true, manifest: { entries: { agent: "0".repeat(64) } } }),
  loadReleaseArtifact: async () => ({ ok: true }),
}));

import { POST as halt } from "@/app/api/content/halt/route";
import { POST as rollback } from "@/app/api/content/rollback/route";
import { POST as publishContent } from "@/app/api/content/release/route";
import { POST as publishBinary } from "@/app/api/release/route";

async function admin() {
  const user = await prisma.user.create({
    data: { id: randomUUID(), email: `${randomUUID()}@example.com`, name: "U" },
  });
  const tenant = await createTestTenant(undefined, { userId: user.id });
  await prisma.member.updateMany({
    where: { organizationId: tenant.id, userId: user.id },
    data: { role: "admin" },
  });
  // provisionTenant's own `tenant.create` row is not what these tests count.
  await prisma.auditLog.deleteMany();
  return { tenantId: tenant.id, userId: user.id };
}

const release = (tenantId: string, ring: string, releaseVersion: number, status: string) =>
  prisma.contentRelease.create({
    data: {
      tenantId,
      ring,
      releaseVersion,
      manifestUrl: `m/${ring}/${releaseVersion}`,
      manifestSha256: "0".repeat(64),
      status,
      releasedAt: new Date(),
    },
  });

const post = (url: string, a: { tenantId: string; userId: string }, body: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "x-tenant-id": a.tenantId, "x-user-id": a.userId, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const statuses = async (tenantId: string) =>
  Object.fromEntries(
    (await prisma.contentRelease.findMany({ where: { tenantId }, orderBy: { releaseVersion: "asc" } })).map(
      (r) => [r.releaseVersion, r.status]
    )
  );

const MANIFEST = { manifestUrl: "https://example.com/m.json", manifestSha256: "a".repeat(64) };

describe("audited control-plane mutations commit with their audit row or not at all", () => {
  beforeEach(async () => {
    fault.failAudit = false;
    await cleanDatabase();
  });
  afterAll(async () => {
    await cleanDatabase();
    await prisma.$disconnect();
  });

  it("a rollback whose audit insert fails changes neither release: the ring keeps its active one", async () => {
    const a = await admin();
    await release(a.tenantId, "prod", 1, "rolled_back");
    await release(a.tenantId, "prod", 2, "active");
    fault.failAudit = true;
    const res = await rollback(post("/api/content/rollback", a, { ring: "prod" }));
    expect(res.status).toBe(500);
    expect(await statuses(a.tenantId)).toEqual({ 1: "rolled_back", 2: "active" });
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("two concurrent rollbacks of a ring run one after the other, each on the state the other left", async () => {
    const a = await admin();
    await release(a.tenantId, "prod", 1, "rolled_back");
    await release(a.tenantId, "prod", 2, "rolled_back");
    await release(a.tenantId, "prod", 3, "active");
    const [r1, r2] = await Promise.all([
      rollback(post("/api/content/rollback", a, { ring: "prod" })),
      rollback(post("/api/content/rollback", a, { ring: "prod" })),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    // 3 -> 2, then 2 -> 1: never both from 3 to 2.
    const audits = await prisma.auditLog.findMany({ where: { action: "content.release.rollback" } });
    const moves = audits
      .map((x) => x.details as { fromVersion: number; toVersion: number })
      .map((d) => `${d.fromVersion}->${d.toVersion}`)
      .sort();
    expect(moves).toEqual(["2->1", "3->2"]);
    expect(await statuses(a.tenantId)).toEqual({ 1: "active", 2: "rolled_back", 3: "rolled_back" });
  });

  it("a halt whose audit insert fails leaves the release active", async () => {
    const a = await admin();
    await release(a.tenantId, "prod", 1, "active");
    fault.failAudit = true;
    const res = await halt(post("/api/content/halt", a, { ring: "prod" }));
    expect(res.status).toBe(500);
    expect(await statuses(a.tenantId)).toEqual({ 1: "active" });
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("a content release whose audit insert fails is not published", async () => {
    const a = await admin();
    fault.failAudit = true;
    const res = await publishContent(post("/api/content/release", a, { ring: "prod", ...MANIFEST }));
    expect(res.status).toBe(500);
    expect(await prisma.contentRelease.count()).toBe(0);

    fault.failAudit = false;
    const ok = await publishContent(post("/api/content/release", a, { ring: "prod", ...MANIFEST }));
    expect(ok.status).toBe(200);
    expect(await statuses(a.tenantId)).toEqual({ 1: "active" });
    expect(await prisma.auditLog.count({ where: { action: "content.release.create" } })).toBe(1);
  });

  it("a content release that loses the number race is still a 409", async () => {
    const a = await admin();
    // A release numbered 1 lands between the route's read of the highest release and its
    // insert; the route then tries number 1 too.
    await release(a.tenantId, "prod", 1, "active");
    const { prisma: appPrisma } = await import("@/lib/prisma");
    const spy = vi.spyOn(appPrisma.contentRelease, "findFirst").mockResolvedValueOnce(null);
    const res = await publishContent(post("/api/content/release", a, { ring: "prod", ...MANIFEST }));
    spy.mockRestore();
    expect(res.status).toBe(409);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("a binary release whose audit insert fails is not published", async () => {
    const a = await admin();
    fault.failAudit = true;
    const body = { ring: "prod", releaseVersion: 1, ...MANIFEST };
    const res = await publishBinary(post("/api/release", a, body));
    expect(res.status).toBe(500);
    expect(await prisma.binaryRelease.count()).toBe(0);

    fault.failAudit = false;
    expect((await publishBinary(post("/api/release", a, body))).status).toBe(200);
    expect(await prisma.binaryRelease.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "release.create" } })).toBe(1);
  });
});
