import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  agent: { findUnique: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

import { authenticateAgent } from "@/lib/agent-auth";

const SECRET = "test-proxy-secret";
const valid = {
  "X-Proxy-Secret": SECRET,
  "X-Client-Cert-Verified": "SUCCESS",
  "X-Client-Cert-Subject": "CN=agent-1,O=synthaea",
};

const request = (headers: Record<string, string>) =>
  new NextRequest("http://localhost/api/ingest/anything", { method: "POST", headers });

const without = (name: keyof typeof valid) => {
  const rest: Record<string, string> = { ...valid };
  delete rest[name];
  return rest;
};

/** The refusal `authenticateAgent` returned, as status and body. */
async function refusal(headers: Record<string, string>) {
  const result = await authenticateAgent(request(headers));
  if (!("response" in result)) throw new Error("expected a refusal, got an agent");
  return { status: result.response.status, body: await result.response.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.NGINX_PROXY_SECRET = SECRET;
  db.agent.findUnique.mockResolvedValue({ id: "agent-db", tenantId: "tenant-db", ring: "canary" });
});

describe("authenticateAgent", () => {
  it("returns the enrolled agent named by a verified certificate that came through the proxy", async () => {
    const result = await authenticateAgent(request(valid));

    expect(result).toEqual({ agent: { id: "agent-db", tenantId: "tenant-db", ring: "canary" } });
    expect(db.agent.findUnique).toHaveBeenCalledWith({
      where: { enrollmentId: "agent-1" },
      select: { id: true, tenantId: true, ring: true },
    });
  });

  it.each([
    ["no proxy secret", without("X-Proxy-Secret")],
    ["a wrong proxy secret", { ...valid, "X-Proxy-Secret": "forged" }],
  ])("refuses a request with %s with 403, before reading the certificate headers", async (_, headers) => {
    expect(await refusal(headers)).toEqual({
      status: 403,
      body: { error: "Forbidden - invalid proxy authentication" },
    });
    expect(db.agent.findUnique).not.toHaveBeenCalled();
  });

  it("refuses every request with 403 when the proxy secret is not configured", async () => {
    delete process.env.NGINX_PROXY_SECRET;

    expect((await refusal(valid)).status).toBe(403);
  });

  it.each([
    ["no verification header", without("X-Client-Cert-Verified")],
    ["a failed verification", { ...valid, "X-Client-Cert-Verified": "FAILED:unknown ca" }],
    ["no certificate subject", without("X-Client-Cert-Subject")],
  ])("refuses a request with %s with 401", async (_, headers) => {
    expect(await refusal(headers)).toEqual({
      status: 401,
      body: { error: "Unauthorized - mTLS authentication required" },
    });
    expect(db.agent.findUnique).not.toHaveBeenCalled();
  });

  it("refuses a certificate subject with no CN with 400", async () => {
    expect(await refusal({ ...valid, "X-Client-Cert-Subject": "O=synthaea" })).toEqual({
      status: 400,
      body: { error: "Invalid certificate subject" },
    });
    expect(db.agent.findUnique).not.toHaveBeenCalled();
  });

  it("refuses a certificate naming no enrolled agent with 403", async () => {
    db.agent.findUnique.mockResolvedValue(null);

    expect(await refusal(valid)).toEqual({ status: 403, body: { error: "Agent not enrolled" } });
  });

  it("lets a database failure propagate, for the route to answer it", async () => {
    db.agent.findUnique.mockRejectedValue(new Error("connection lost"));

    await expect(authenticateAgent(request(valid))).rejects.toThrow("connection lost");
  });
});
