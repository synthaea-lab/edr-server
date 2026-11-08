import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { cleanDatabase, createTestTenant, prisma } from "../helpers/db";
import { createTenantHeaders } from "../helpers/http";
import { GET as ringHealth } from "@/app/api/rings/[ring]/health/route";
import { GET as checkRingHealth } from "@/app/api/cron/check-ring-health/route";

// Characterization tests for the two places that compute ring health today: the
// per-ring console endpoint and the auto-halt cron. They pin the metrics (5-minute
// silence threshold, 24-hour detection window, severity "low" counted as a false
// positive), the health thresholds and the halt side effects, so SV-007 can move both
// onto one `lib/ring-health.ts` without changing an answer.

const MINUTE = 60 * 1000;
const fresh = () => new Date();
const silent = () => new Date(Date.now() - 10 * MINUTE);

/** Creates `count` agents in `ring`, each last seen at `lastSeen()`; returns their ids. */
async function agents(tenantId: string, ring: string, count: number, lastSeen: () => Date) {
  const ids = Array.from({ length: count }, () => randomUUID());
  await prisma.agent.createMany({
    data: ids.map((id) => ({ id, tenantId, ring, enrollmentId: `e-${id}`, lastSeen: lastSeen() })),
  });
  return ids;
}

async function detections(tenantId: string, agentId: string, count: number, severity: string, timestamp = new Date()) {
  await prisma.detection.createMany({
    data: Array.from({ length: count }, () => ({
      tenantId,
      agentId,
      severity,
      timestamp,
      technique: "T1059.001",
      event: { test: "data" },
      meta: { test: "meta" },
    })),
  });
}

const release = (tenantId: string, ring: string, releaseVersion: number, status: string) =>
  prisma.contentRelease.create({
    data: {
      tenantId,
      ring,
      releaseVersion,
      manifestUrl: `storage://manifests/content-${ring}-v${releaseVersion}.json`,
      manifestSha256: "a".repeat(64),
      status,
      releasedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });

const getHealth = (ring: string, headers: Record<string, string>) =>
  ringHealth(new NextRequest(`http://localhost/api/rings/${ring}/health`, { headers }), { params: { ring } });

const runCron = (authorization = `Bearer ${process.env.CRON_SECRET}`) =>
  checkRingHealth(
    new NextRequest("http://localhost/api/cron/check-ring-health", { headers: { Authorization: authorization } })
  );

afterAll(async () => {
  await cleanDatabase();
  await prisma.$disconnect();
});

describe("GET /api/rings/[ring]/health", () => {
  beforeEach(cleanDatabase);

  it("refuses an unknown ring with 400 and the valid rings", async () => {
    const tenant = await createTestTenant();

    const res = await getHealth("canary_9", createTenantHeaders(tenant.id));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid ring",
      validRings: ["canary_0", "canary_1", "canary_2", "prod"],
    });
  });

  it("answers a caller with no tenant context with 500 (current behavior, see SV-004)", async () => {
    const res = await getHealth("prod", {});

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
  });

  it("reports an empty ring as healthy with zero counts and no release", async () => {
    const tenant = await createTestTenant();

    const res = await getHealth("canary_0", createTenantHeaders(tenant.id));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ring: "canary_0",
      totalAgents: 0,
      healthyAgents: 0,
      silentAgents: 0,
      silentRate: 0,
      contentRelease: null,
      recentDetections: 0,
      falsePositives: 0,
      healthStatus: "healthy",
    });
  });

  it("counts the ring's own agents and their last-24h detections, low severity as false positives", async () => {
    const tenant = await createTestTenant();
    const other = await createTestTenant();
    const [a1] = await agents(tenant.id, "canary_1", 2, fresh);
    await agents(tenant.id, "canary_1", 1, silent);
    const [prodAgent] = await agents(tenant.id, "prod", 1, fresh);
    const [otherAgent] = await agents(other.id, "canary_1", 1, silent);
    await detections(tenant.id, a1, 2, "high");
    await detections(tenant.id, a1, 1, "low");
    await detections(tenant.id, a1, 1, "low", new Date(Date.now() - 25 * 60 * MINUTE)); // outside the window
    await detections(tenant.id, prodAgent, 4, "low"); // another ring
    await detections(other.id, otherAgent, 4, "low"); // another tenant
    await release(tenant.id, "canary_1", 1, "active");
    await release(tenant.id, "canary_1", 2, "rolled_back");

    const res = await getHealth("canary_1", createTenantHeaders(tenant.id));

    expect(await res.json()).toEqual({
      ring: "canary_1",
      totalAgents: 3,
      healthyAgents: 2,
      silentAgents: 1,
      silentRate: 0.33,
      contentRelease: { releaseVersion: 2, status: "rolled_back", releasedAt: "2026-01-01T00:00:00.000Z" },
      recentDetections: 3,
      falsePositives: 1,
      healthStatus: "unhealthy",
    });
  });

  it.each([
    // [healthy, silent, silentRate, healthStatus]
    [49, 1, 0.02, "healthy"], // exactly 2% is still healthy
    [29, 1, 0.03, "degraded"],
    [19, 1, 0.05, "degraded"], // exactly 5% is still only degraded
    [18, 1, 0.05, "unhealthy"], // 1/19 shows as 0.05, but the status uses the unrounded rate
  ])("maps %i healthy and %i silent agents to silentRate %f and %s", async (healthy, quiet, rate, status) => {
    const tenant = await createTestTenant();
    await agents(tenant.id, "prod", healthy, fresh);
    await agents(tenant.id, "prod", quiet, silent);

    const body = await (await getHealth("prod", createTenantHeaders(tenant.id))).json();

    expect(body.silentRate).toBe(rate);
    expect(body.healthStatus).toBe(status);
  });
});

describe("GET /api/cron/check-ring-health", () => {
  beforeEach(cleanDatabase);

  it("refuses a call without the cron bearer with 401", async () => {
    const res = await runCron("Bearer wrong");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("checks the three canary rings of every tenant", async () => {
    await createTestTenant();
    await createTestTenant();

    const res = await runCron();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", checked: 6, halted: [] });
  });

  it("halts the latest active release of a ring with too many silent agents, opens a case and audits it", async () => {
    const tenant = await createTestTenant();
    await agents(tenant.id, "prod", 1, fresh);
    await agents(tenant.id, "canary_0", 1, fresh);
    await agents(tenant.id, "canary_0", 1, silent);
    const older = await release(tenant.id, "canary_0", 1, "active");
    const latest = await release(tenant.id, "canary_0", 2, "active");
    const untouched = await release(tenant.id, "canary_1", 1, "active");
    const reason = "Silent agent rate 50.00% exceeds threshold 5%";

    const res = await runCron();

    expect(await res.json()).toEqual({
      status: "ok",
      checked: 3,
      halted: [{ tenantId: tenant.id, ring: "canary_0", reason }],
    });
    const statuses = await prisma.contentRelease.findMany({ select: { id: true, status: true } });
    expect(Object.fromEntries(statuses.map((r) => [r.id, r.status]))).toEqual({
      [older.id]: "active",
      [latest.id]: "halted",
      [untouched.id]: "active",
    });

    const cases = await prisma.case.findMany({ where: { tenantId: tenant.id } });
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      title: "Auto-halt: canary_0 deployment regression",
      severity: "high",
      status: "open",
    });
    expect(cases[0].description).toBe(
      "Content release v2 for ring canary_0 was automatically halted due to health regression.\n\n" +
        "Metrics:\n" +
        "- Silent rate: 50.00% (threshold: 5%)\n" +
        "- FP rate: 0 (baseline: 0, max increase: 2×)\n" +
        "- Detection rate: 0 (baseline: 0, max drop: 20%)\n\n" +
        `Reason: ${reason}`
    );

    const audit = await prisma.auditLog.findMany({ where: { tenantId: tenant.id, action: "content.release.auto_halt" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      userId: "system",
      resource: `content_releases/${latest.id}`,
      details: {
        ring: "canary_0",
        releaseVersion: 2,
        reason,
        metrics: {
          canary: { totalAgents: 2, healthyAgents: 1, silentAgents: 1, silentRate: 0.5, detectionCount: 0, fpCount: 0 },
          baseline: { totalAgents: 1, healthyAgents: 1, silentAgents: 0, silentRate: 0, detectionCount: 0, fpCount: 0 },
        },
      },
    });
  });

  it("does nothing more on the next run once the ring's only active release is halted", async () => {
    const tenant = await createTestTenant();
    await agents(tenant.id, "prod", 1, fresh);
    await agents(tenant.id, "canary_0", 1, silent);
    await release(tenant.id, "canary_0", 1, "active");

    await runCron();
    const second = await (await runCron()).json();

    expect(second.halted).toEqual([]);
    expect(await prisma.case.count({ where: { tenantId: tenant.id } })).toBe(1);
  });

  it("halts nothing for a regressed ring with no active release", async () => {
    const tenant = await createTestTenant();
    await agents(tenant.id, "prod", 1, fresh);
    await agents(tenant.id, "canary_0", 1, silent);
    await release(tenant.id, "canary_0", 1, "rolled_back");

    const body = await (await runCron()).json();

    expect(body.halted).toEqual([]);
    expect(await prisma.case.count()).toBe(0);
  });

  it("skips the comparison when prod has no agents", async () => {
    const tenant = await createTestTenant();
    await agents(tenant.id, "canary_0", 3, silent);
    await release(tenant.id, "canary_0", 1, "active");

    const body = await (await runCron()).json();

    expect(body.halted).toEqual([]);
  });

  it.each([
    // [label, prod: [high, low], canary: [high, low], reason or null]
    ["more than 10 FPs against a baseline of none", [0, 0], [0, 11], "FP rate spike: 11 FPs (baseline: 0)"],
    ["10 FPs against a baseline of none", [0, 0], [0, 10], null],
    ["more than twice the baseline FPs", [0, 1], [0, 3], "FP rate increased 3.00× (3 vs baseline 1)"],
    ["exactly twice the baseline FPs", [0, 1], [0, 2], null],
    ["a detection drop above 20%", [10, 0], [7, 0], "Detection rate dropped 30% (7 vs baseline 10)"],
    ["a detection drop of 20%", [10, 0], [8, 0], null],
  ])("on %s, halts with the expected reason", async (_label, prod, canary, reason) => {
    const tenant = await createTestTenant();
    const [prodAgent] = await agents(tenant.id, "prod", 1, fresh);
    const [canaryAgent] = await agents(tenant.id, "canary_2", 1, fresh);
    await detections(tenant.id, prodAgent, prod[0], "high");
    await detections(tenant.id, prodAgent, prod[1], "low");
    await detections(tenant.id, canaryAgent, canary[0], "high");
    await detections(tenant.id, canaryAgent, canary[1], "low");
    await release(tenant.id, "canary_2", 1, "active");

    const body = await (await runCron()).json();

    expect(body.halted).toEqual(reason ? [{ tenantId: tenant.id, ring: "canary_2", reason }] : []);
  });
});
