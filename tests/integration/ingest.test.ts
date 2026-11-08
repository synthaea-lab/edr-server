import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { cleanDatabase, createTestAgent, createTestTenant, prisma } from "../helpers/db";
import { createDetectionPayload, createMtlsHeaders } from "../helpers/http";
import { POST as ingestDetection } from "@/app/api/ingest/detection/route";
import { POST as heartbeat } from "@/app/api/ingest/heartbeat/route";

const SECRET = "test-proxy-secret";
const MINUTE_AGO = () => new Date(Date.now() - 60_000);

function agentRequest(path: string, enrollmentId: string, body: unknown, extra: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { ...createMtlsHeaders(enrollmentId), "X-Proxy-Secret": SECRET, ...extra },
    body: JSON.stringify(body),
  });
}

const postDetection = (enrollmentId: string, body: unknown, extra?: Record<string, string>) =>
  ingestDetection(agentRequest("/api/ingest/detection", enrollmentId, body, extra));

describe("Ingest API (real database)", () => {
  beforeEach(async () => {
    process.env.NGINX_PROXY_SECRET = SECRET;
    await cleanDatabase();
  });

  afterAll(async () => {
    await cleanDatabase();
    await prisma.$disconnect();
  });

  describe("POST /api/ingest/detection", () => {
    it("stores a detection from an enrolled agent under its tenant and marks the agent alive", async () => {
      const tenant = await createTestTenant();
      const agent = await createTestAgent(tenant.id, "agent-test-001", { lastSeen: MINUTE_AGO() });
      const payload = createDetectionPayload({ technique: "T1059.001", severity: "critical" });

      const res = await postDetection(agent.enrollmentId, payload);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "accepted" });
      const stored = await prisma.detection.findMany({ where: { agentId: agent.id } });
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        tenantId: tenant.id,
        technique: "T1059.001",
        severity: "critical",
        timestamp: new Date(payload.timestamp_ns / 1_000_000),
      });
      const after = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
      expect(after.lastSeen.getTime()).toBeGreaterThan(agent.lastSeen.getTime());
    });

    it("refuses a detection with an invalid severity with 400 and stores nothing", async () => {
      const tenant = await createTestTenant();
      const agent = await createTestAgent(tenant.id);

      const res = await postDetection(agent.enrollmentId, { ...createDetectionPayload(), severity: "invalid" });

      expect(res.status).toBe(400);
      expect(await prisma.detection.count()).toBe(0);
    });

    it("stores a retried detection once when the agent resends it under the same Idempotency-Key", async () => {
      const tenant = await createTestTenant();
      const agent = await createTestAgent(tenant.id);
      const payload = createDetectionPayload();
      const key = { "Idempotency-Key": "b9628fc1-2134-4d4d-bbe6-83fdd1929d7a" };

      expect((await postDetection(agent.enrollmentId, payload, key)).status).toBe(200);
      expect((await postDetection(agent.enrollmentId, payload, key)).status).toBe(200);

      expect(await prisma.detection.count({ where: { agentId: agent.id } })).toBe(1);
    });

    it("refuses with 409 an Idempotency-Key reused for a different detection", async () => {
      const tenant = await createTestTenant();
      const agent = await createTestAgent(tenant.id);
      const key = { "Idempotency-Key": "b9628fc1-2134-4d4d-bbe6-83fdd1929d7a" };

      await postDetection(agent.enrollmentId, createDetectionPayload({ technique: "T1059" }), key);
      const res = await postDetection(agent.enrollmentId, createDetectionPayload({ technique: "T1486" }), key);

      expect(res.status).toBe(409);
      expect(await prisma.detection.count({ where: { agentId: agent.id } })).toBe(1);
    });

    it("keeps the same Idempotency-Key from two agents apart", async () => {
      const tenant = await createTestTenant();
      const first = await createTestAgent(tenant.id);
      const second = await createTestAgent(tenant.id);
      const payload = createDetectionPayload();
      const key = { "Idempotency-Key": "b9628fc1-2134-4d4d-bbe6-83fdd1929d7a" };

      expect((await postDetection(first.enrollmentId, payload, key)).status).toBe(200);
      expect((await postDetection(second.enrollmentId, payload, key)).status).toBe(200);

      expect(await prisma.detection.count()).toBe(2);
    });
  });

  describe("POST /api/ingest/heartbeat", () => {
    it("marks the agent alive and answers with its id and ring", async () => {
      const tenant = await createTestTenant();
      const agent = await createTestAgent(tenant.id, "agent-heartbeat-001", {
        ring: "canary_0",
        lastSeen: MINUTE_AGO(),
      });

      const res = await heartbeat(agentRequest("/api/ingest/heartbeat", agent.enrollmentId, {}));

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "ok", agentId: agent.id, ring: "canary_0" });
      const after = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
      expect(after.lastSeen.getTime()).toBeGreaterThan(agent.lastSeen.getTime());
    });

    it("refuses a certificate naming no enrolled agent with 403", async () => {
      const res = await heartbeat(agentRequest("/api/ingest/heartbeat", "non-existent-agent", {}));

      expect(res.status).toBe(403);
    });
  });
});
