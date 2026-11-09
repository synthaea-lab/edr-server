import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { cleanDatabase, createTestAgent, createTestTenant, prisma } from "../helpers/db";
import { createMtlsHeaders, createTenantHeaders } from "../helpers/http";
import { POST as submit } from "@/app/api/corpus/submit/route";
import { POST as finalize } from "@/app/api/corpus/finalize/route";
import { GET as listVersions } from "@/app/api/corpus/versions/route";

// Characterization tests: they pin what the three corpus routes answer today, so the
// refactors that move their logic into `lib/` (SV-019, SV-020) and the auth change on
// `submit` (SV-003b) start from an executable spec. Assertions marked "current behavior"
// pin answers those items are expected to change.

const sample = (timestamp: string, eventType = "exec", event: Record<string, unknown> = { pid: 1 }) => ({
  timestamp,
  eventType,
  event,
});

/** Calls the submit route as the agent `enrollmentId`, or with explicit `headers`. */
function submitReq(enrollmentId: string, body: unknown, headers?: Record<string, string>) {
  return submit(
    new NextRequest("http://localhost/api/corpus/submit", {
      method: "POST",
      headers: headers ?? createMtlsHeaders(enrollmentId),
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
}

function finalizeReq(tenantId: string, userId: string, body: unknown) {
  return new NextRequest("http://localhost/api/corpus/finalize", {
    method: "POST",
    headers: createTenantHeaders(tenantId, userId),
    body: JSON.stringify(body),
  });
}

function versionsReq(query: string, headers: Record<string, string>) {
  return new NextRequest(`http://localhost/api/corpus/versions${query}`, { headers });
}

/** A tenant whose owner member has `role`, as `requireTenantAdmin` reads it. */
async function tenantWithMember(role: string) {
  const user = await prisma.user.create({
    data: { id: randomUUID(), email: `${randomUUID()}@example.com`, name: "U" },
  });
  const tenant = await createTestTenant(undefined, { userId: user.id });
  await prisma.member.updateMany({
    where: { organizationId: tenant.id, userId: user.id },
    data: { role },
  });
  return { tenantId: tenant.id, userId: user.id };
}

const corpusVersion = (tenantId: string, version: number, status = "collecting", sampleCount = 0) =>
  prisma.corpusVersion.create({
    data: { tenantId, version, status, sampleCount, collectionStart: new Date() },
  });

afterAll(async () => {
  await cleanDatabase();
  await prisma.$disconnect();
});

describe("POST /api/corpus/submit", () => {
  beforeEach(cleanDatabase);

  it("refuses a request whose client certificate was not verified with 401", async () => {
    const res = await submitReq("e1", {}, {
      "X-Client-Cert-Verified": "FAILED",
      "X-Client-Cert-Subject": "CN=e1,O=synthaea",
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized - mTLS authentication required" });
  });

  it("refuses a verified certificate with no subject with 401", async () => {
    const res = await submitReq("e1", {}, { "X-Client-Cert-Verified": "SUCCESS" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized - mTLS authentication required" });
  });

  it("refuses a subject with no CN with 400", async () => {
    const res = await submitReq("e1", {}, {
      "X-Client-Cert-Verified": "SUCCESS",
      "X-Client-Cert-Subject": "O=synthaea",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid certificate subject" });
  });

  it("refuses an enrollment id with no agent with 403", async () => {
    const res = await submitReq("not-enrolled", { corpusVersion: 1, samples: [sample("2026-01-01T00:00:00Z")] });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Agent not enrolled" });
  });

  it("accepts an enrolled agent without the proxy secret header (current behavior, see SV-003)", async () => {
    const tenant = await createTestTenant();
    await createTestAgent(tenant.id, "e-noproxy");
    const headers = createMtlsHeaders("e-noproxy");
    expect(headers).not.toHaveProperty("X-Proxy-Secret");

    const res = await submitReq("e-noproxy", { corpusVersion: 1, samples: [sample("2026-01-01T00:00:00Z")] });

    expect(res.status).toBe(200);
  });

  it("refuses an invalid body with 400 and the zod issues", async () => {
    const tenant = await createTestTenant();
    await createTestAgent(tenant.id, "e-bad");

    const res = await submitReq("e-bad", { corpusVersion: 1, samples: [] });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid request");
    expect(body.details[0].path).toEqual(["samples"]);
    expect(await prisma.corpusVersion.count()).toBe(0);
  });

  it("answers a malformed JSON body with 500 (current behavior, see SV-005)", async () => {
    const tenant = await createTestTenant();
    await createTestAgent(tenant.id, "e-json");

    const res = await submitReq("e-json", "{not json");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
  });

  it("creates the version on first submit and stores every sample with its provenance", async () => {
    const tenant = await createTestTenant();
    const agent = await createTestAgent(tenant.id, "e-first");

    const res = await submitReq("e-first", {
      corpusVersion: 3,
      samples: [
        sample("2026-01-01T00:00:00Z", "exec", { pid: 1 }),
        sample("2026-01-01T00:00:01Z", "connect", { port: 443 }),
      ],
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "accepted",
      samplesAccepted: 2,
      corpusVersion: 3,
      totalSamples: 2,
    });
    const version = await prisma.corpusVersion.findUniqueOrThrow({
      where: { tenantId_version: { tenantId: tenant.id, version: 3 } },
    });
    expect(version).toMatchObject({ status: "collecting", sampleCount: 2, collectionEnd: null });
    const samples = await prisma.corpusSample.findMany({ orderBy: { timestamp: "asc" } });
    expect(samples.map((s) => [s.tenantId, s.corpusVersionId, s.agentId, s.eventType, s.event])).toEqual([
      [tenant.id, version.id, agent.id, "exec", { pid: 1 }],
      [tenant.id, version.id, agent.id, "connect", { port: 443 }],
    ]);
  });

  it("adds later submits to the same version and reports the running total", async () => {
    const tenant = await createTestTenant();
    await createTestAgent(tenant.id, "e-a");
    await createTestAgent(tenant.id, "e-b");

    await submitReq("e-a", { corpusVersion: 1, samples: [sample("2026-01-01T00:00:00Z")] });
    const res = await submitReq("e-b", {
      corpusVersion: 1,
      samples: [sample("2026-01-01T00:00:01Z"), sample("2026-01-01T00:00:02Z")],
    });

    expect((await res.json()).totalSamples).toBe(3);
    expect(await prisma.corpusVersion.count()).toBe(1);
    expect((await prisma.corpusVersion.findFirstOrThrow()).sampleCount).toBe(3);
  });

  it("keeps each tenant's version of the same number apart", async () => {
    const t1 = await createTestTenant();
    const t2 = await createTestTenant();
    await createTestAgent(t1.id, "e-t1");
    await createTestAgent(t2.id, "e-t2");

    await submitReq("e-t1", { corpusVersion: 1, samples: [sample("2026-01-01T00:00:00Z")] });
    const res = await submitReq("e-t2", { corpusVersion: 1, samples: [sample("2026-01-01T00:00:00Z")] });

    expect((await res.json()).totalSamples).toBe(1);
    const versions = await prisma.corpusVersion.findMany({ orderBy: { tenantId: "asc" } });
    expect(versions.map((v) => v.sampleCount)).toEqual([1, 1]);
    expect(new Set(versions.map((v) => v.tenantId))).toEqual(new Set([t1.id, t2.id]));
  });

  it("refuses samples for a version that is no longer collecting with 409", async () => {
    const tenant = await createTestTenant();
    await createTestAgent(tenant.id, "e-late");
    await corpusVersion(tenant.id, 1, "finalized", 5);

    const res = await submitReq("e-late", { corpusVersion: 1, samples: [sample("2026-01-01T00:00:00Z")] });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Corpus version is finalized",
      message: "Version 1 is no longer accepting samples (status: finalized)",
    });
    expect(await prisma.corpusSample.count()).toBe(0);
  });

  it("puts concurrent first submits of a version into one row", async () => {
    const tenant = await createTestTenant();
    const ids = ["e-c1", "e-c2", "e-c3", "e-c4", "e-c5"];
    for (const id of ids) await createTestAgent(tenant.id, id);

    const responses = await Promise.all(
      ids.map((id) => submitReq(id, { corpusVersion: 7, samples: [sample("2026-01-01T00:00:00Z")] }))
    );

    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const totals = await Promise.all(responses.map(async (r) => (await r.json()).totalSamples));
    expect([...totals].sort()).toEqual([1, 2, 3, 4, 5]);
    const version = await prisma.corpusVersion.findFirstOrThrow();
    expect(await prisma.corpusVersion.count()).toBe(1);
    expect(version.sampleCount).toBe(5);
    expect(await prisma.corpusSample.count({ where: { corpusVersionId: version.id } })).toBe(5);
  });

  it("refuses a submit that waited on a finalize holding the version with 409", async () => {
    const tenant = await createTestTenant();
    await createTestAgent(tenant.id, "e-race");
    const version = await corpusVersion(tenant.id, 1);

    let submitted!: Promise<Response>;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM corpus_versions WHERE id = ${version.id} FOR UPDATE`;
      submitted = submitReq("e-race", { corpusVersion: 1, samples: [sample("2026-01-01T00:00:00Z")] });
      // Let the submit read the version before the finalize commits.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await tx.corpusVersion.update({ where: { id: version.id }, data: { status: "finalized" } });
    });
    const res = await submitted;

    expect(res.status).toBe(409);
    expect(await prisma.corpusSample.count()).toBe(0);
    expect((await prisma.corpusVersion.findFirstOrThrow()).sampleCount).toBe(0);
  });
});

describe("POST /api/corpus/finalize", () => {
  let originalCwd: string;
  let workDir: string;

  beforeEach(async () => {
    await cleanDatabase();
    // The route writes the export under `process.cwd()/storage`.
    originalCwd = process.cwd();
    workDir = await mkdtemp(path.join(tmpdir(), "corpus-finalize-"));
    process.chdir(workDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(workDir, { recursive: true, force: true });
  });

  it("refuses a caller with no tenant context with 401", async () => {
    const res = await finalize(
      new NextRequest("http://localhost/api/corpus/finalize", { method: "POST", body: "{}" })
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
  });

  it("refuses a plain member with 403", async () => {
    const { tenantId, userId } = await tenantWithMember("member");
    await corpusVersion(tenantId, 1);

    const res = await finalize(finalizeReq(tenantId, userId, { version: 1 }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Admin role required" });
    expect((await prisma.corpusVersion.findFirstOrThrow()).status).toBe("collecting");
  });

  it("refuses an invalid body with 400", async () => {
    const { tenantId, userId } = await tenantWithMember("admin");

    const res = await finalize(finalizeReq(tenantId, userId, { version: 0 }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid request");
    expect(body.details[0].path).toEqual(["version"]);
  });

  it("answers 404 for a version the tenant does not have, including another tenant's", async () => {
    const { tenantId, userId } = await tenantWithMember("admin");
    const other = await createTestTenant();
    await corpusVersion(other.id, 1);

    const res = await finalize(finalizeReq(tenantId, userId, { version: 1 }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Corpus version not found" });
    expect((await prisma.corpusVersion.findFirstOrThrow()).status).toBe("collecting");
  });

  it("refuses a version that is not collecting with 409", async () => {
    const { tenantId, userId } = await tenantWithMember("owner");
    await corpusVersion(tenantId, 2, "archived");

    const res = await finalize(finalizeReq(tenantId, userId, { version: 2 }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Corpus already finalized",
      message: "Version 2 is already in status: archived",
    });
  });

  it("exports the samples as JSONL in timestamp order, records the hash and audits the finalize", async () => {
    const { tenantId, userId } = await tenantWithMember("admin");
    const agent = await createTestAgent(tenantId, "e-fin");
    const version = await corpusVersion(tenantId, 1, "collecting", 2);
    await prisma.corpusSample.createMany({
      data: [
        { tenantId, corpusVersionId: version.id, agentId: agent.id, timestamp: new Date("2026-01-01T00:00:02Z"), eventType: "connect", event: { port: 443 } },
        { tenantId, corpusVersionId: version.id, agentId: agent.id, timestamp: new Date("2026-01-01T00:00:01Z"), eventType: "exec", event: { pid: 7 } },
      ],
    });

    const res = await finalize(finalizeReq(tenantId, userId, { version: 1 }));
    const body = await res.json();

    const exportUrl = `/storage/corpus/${tenantId}/corpus-v1.jsonl`;
    const written = await readFile(path.join(workDir, "storage", "corpus", tenantId, "corpus-v1.jsonl"), "utf-8");
    expect(written).toBe(
      [
        JSON.stringify({ timestamp: "2026-01-01T00:00:01.000Z", event_type: "exec", event: { pid: 7 }, agent_id: agent.id }),
        JSON.stringify({ timestamp: "2026-01-01T00:00:02.000Z", event_type: "connect", event: { port: 443 }, agent_id: agent.id }),
      ].join("\n") + "\n"
    );
    const sha256 = createHash("sha256").update(written).digest("hex");

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "finalized", version: 1, sampleCount: 2, exportUrl, exportSha256: sha256 });

    const stored = await prisma.corpusVersion.findUniqueOrThrow({ where: { id: version.id } });
    expect(stored).toMatchObject({ status: "finalized", exportUrl, exportSha256: sha256 });
    expect(stored.collectionEnd).toBeInstanceOf(Date);

    const audit = await prisma.auditLog.findMany({ where: { tenantId, action: "corpus.version.finalize" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      userId,
      action: "corpus.version.finalize",
      resource: `corpus_versions/${version.id}`,
      details: { version: 1, sampleCount: 2, exportUrl, exportSha256: sha256 },
    });
  });

  it("reports the stored sample count, not the number of exported rows", async () => {
    const { tenantId, userId } = await tenantWithMember("admin");
    await corpusVersion(tenantId, 1, "collecting", 9);

    const res = await finalize(finalizeReq(tenantId, userId, { version: 1 }));
    const body = await res.json();

    // An empty export is a single newline.
    const written = await readFile(path.join(workDir, "storage", "corpus", tenantId, "corpus-v1.jsonl"), "utf-8");
    expect(written).toBe("\n");
    expect(body.sampleCount).toBe(9);
    expect(body.exportSha256).toBe(createHash("sha256").update("\n").digest("hex"));
  });
});

describe("GET /api/corpus/versions", () => {
  beforeEach(cleanDatabase);

  it("lists only the caller's tenant's versions, newest version first, with the public fields", async () => {
    const tenant = await createTestTenant();
    const other = await createTestTenant();
    await corpusVersion(tenant.id, 1, "finalized", 4);
    await corpusVersion(tenant.id, 2, "collecting", 1);
    await corpusVersion(other.id, 3);

    const res = await listVersions(versionsReq("", createTenantHeaders(tenant.id)));
    const { versions } = await res.json();

    expect(res.status).toBe(200);
    expect(versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(Object.keys(versions[0]).sort()).toEqual(
      ["collectionEnd", "collectionStart", "createdAt", "exportSha256", "exportUrl", "id", "sampleCount", "status", "version"]
    );
  });

  it("filters by status and honours limit", async () => {
    const tenant = await createTestTenant();
    await corpusVersion(tenant.id, 1, "finalized");
    await corpusVersion(tenant.id, 2, "finalized");
    await corpusVersion(tenant.id, 3, "collecting");

    const byStatus = await (await listVersions(versionsReq("?status=finalized", createTenantHeaders(tenant.id)))).json();
    const limited = await (await listVersions(versionsReq("?limit=1", createTenantHeaders(tenant.id)))).json();

    expect(byStatus.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(limited.versions.map((v: { version: number }) => v.version)).toEqual([3]);
  });

  it("answers an unknown status filter with an empty list", async () => {
    const tenant = await createTestTenant();
    await corpusVersion(tenant.id, 1);

    const res = await listVersions(versionsReq("?status=nope", createTenantHeaders(tenant.id)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ versions: [] });
  });

  it("answers a non-numeric limit with 500 (current behavior, see SV-016)", async () => {
    const tenant = await createTestTenant();

    const res = await listVersions(versionsReq("?limit=abc", createTenantHeaders(tenant.id)));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
  });

  it("refuses a caller with no tenant context with 401", async () => {
    const res = await listVersions(versionsReq("", {}));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
  });
});
