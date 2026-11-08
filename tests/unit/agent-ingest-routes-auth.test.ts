import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The agent authentication answers of the ingest routes, pinned per route: they must stay the
 * same whichever code produces them (the routes share `authenticateAgent`).
 */
const db = vi.hoisted(() => ({
  agent: { findUnique: vi.fn(), update: vi.fn() },
  agentHealth: { findUnique: vi.fn(), upsert: vi.fn() },
  detection: { create: vi.fn(), findUnique: vi.fn() },
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

import { POST as detection } from "@/app/api/ingest/detection/route";
import { POST as heartbeat } from "@/app/api/ingest/heartbeat/route";
import { POST as decoy } from "@/app/api/ingest/decoy/route";

const SECRET = "test-proxy-secret";
const valid = {
  "X-Proxy-Secret": SECRET,
  "X-Client-Cert-Verified": "SUCCESS",
  "X-Client-Cert-Subject": "CN=agent-1,O=synthaea",
  "Content-Type": "application/json",
};

const routes = [
  ["detection", detection],
  ["heartbeat", heartbeat],
  ["decoy", decoy],
] as const;

const call = (route: (req: NextRequest) => Promise<Response>, headers: Record<string, string>) =>
  route(new NextRequest("http://localhost/api/ingest/x", { method: "POST", headers, body: "{}" }));

const answer = async (res: Response) => ({ status: res.status, body: await res.json() });

const notFound = Object.assign(new Error("Record to update not found."), { code: "P2025" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.NGINX_PROXY_SECRET = SECRET;
  db.agent.findUnique.mockResolvedValue({ id: "agent-db", tenantId: "tenant-db", ring: "canary" });
  db.agent.update.mockResolvedValue({
    id: "agent-db",
    tenantId: "tenant-db",
    ring: "canary",
    lastSeen: new Date("2026-01-01T00:00:00Z"),
  });
  db.$executeRaw.mockResolvedValue(1);
});

describe.each(routes)("POST /api/ingest/%s agent authentication", (_, route) => {
  it("refuses a request that did not come through the proxy with 403", async () => {
    expect(await answer(await call(route, { ...valid, "X-Proxy-Secret": "forged" }))).toEqual({
      status: 403,
      body: { error: "Forbidden - invalid proxy authentication" },
    });
    expect(db.agent.findUnique).not.toHaveBeenCalled();
    expect(db.agent.update).not.toHaveBeenCalled();
  });

  it("refuses a request without a verified client certificate with 401", async () => {
    expect(await answer(await call(route, { ...valid, "X-Client-Cert-Verified": "NONE" }))).toEqual({
      status: 401,
      body: { error: "Unauthorized - mTLS authentication required" },
    });
  });

  it("refuses a certificate subject with no CN with 400", async () => {
    expect(await answer(await call(route, { ...valid, "X-Client-Cert-Subject": "O=synthaea" }))).toEqual({
      status: 400,
      body: { error: "Invalid certificate subject" },
    });
  });

  it("refuses a certificate naming no enrolled agent with 403", async () => {
    db.agent.findUnique.mockResolvedValue(null);
    db.agent.update.mockRejectedValue(notFound);

    expect(await answer(await call(route, valid))).toEqual({
      status: 403,
      body: { error: "Agent not enrolled" },
    });
  });

  it("answers 500 when the agent lookup fails", async () => {
    db.agent.findUnique.mockRejectedValue(new Error("connection lost"));
    db.agent.update.mockRejectedValue(new Error("connection lost"));

    expect(await answer(await call(route, valid))).toEqual({
      status: 500,
      body: { error: "Internal server error" },
    });
  });
});

describe("POST /api/ingest/heartbeat", () => {
  it("marks the authenticated agent seen and answers with its id, ring and last-seen time", async () => {
    expect(await answer(await call(heartbeat, valid))).toEqual({
      status: 200,
      body: { status: "ok", agentId: "agent-db", ring: "canary", lastSeen: "2026-01-01T00:00:00.000Z" },
    });
    expect(db.agent.update).toHaveBeenCalledTimes(1);
    expect(db.agent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lastSeen: expect.any(Date) } })
    );
  });
});
