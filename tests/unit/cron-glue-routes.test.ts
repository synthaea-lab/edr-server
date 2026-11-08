import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The prune-artifacts and deliver-notifications crons are thin routes over tested `lib/`
// functions. These tests pin only the route's own part: the cron guard, how the lib result
// becomes the response, and how a failure maps to a status. Prisma and the lib functions are
// mocked, so no database is needed.
const lib = vi.hoisted(() => ({
  pruneUnreferencedArtifacts: vi.fn(),
  deliverDue: vi.fn(),
  purge: vi.fn(),
  evaluateHostTransitions: vi.fn(),
  scheduleDecoyReport: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/decoy", () => ({ scheduleDecoyReport: lib.scheduleDecoyReport }));
vi.mock("@/lib/content-retention", () => ({ pruneUnreferencedArtifacts: lib.pruneUnreferencedArtifacts }));
vi.mock("@/lib/notify/outbox", () => ({ deliverDue: lib.deliverDue, purge: lib.purge }));
vi.mock("@/lib/notify/host-transitions", () => ({ evaluateHostTransitions: lib.evaluateHostTransitions }));

import { GET as pruneArtifacts } from "@/app/api/cron/prune-artifacts/route";
import { GET as deliverNotifications } from "@/app/api/cron/deliver-notifications/route";

const cronReq = (path: string, authorization = `Bearer ${process.env.CRON_SECRET}`) =>
  new NextRequest(`http://localhost${path}`, { headers: { Authorization: authorization } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each([
  ["/api/cron/prune-artifacts", pruneArtifacts],
  ["/api/cron/deliver-notifications", deliverNotifications],
])("GET %s guard", (path, handler) => {
  it("refuses a wrong bearer with 401 and runs nothing", async () => {
    const res = await handler(cronReq(path, "Bearer wrong"));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(lib.pruneUnreferencedArtifacts).not.toHaveBeenCalled();
    expect(lib.evaluateHostTransitions).not.toHaveBeenCalled();
    expect(lib.deliverDue).not.toHaveBeenCalled();
    expect(lib.purge).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/prune-artifacts", () => {
  it("answers the retention result as is", async () => {
    const result = { deleted: ["a"], kept: 2, skippedYoung: 1 };
    lib.pruneUnreferencedArtifacts.mockResolvedValue(result);

    const res = await pruneArtifacts(cronReq("/api/cron/prune-artifacts"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(lib.pruneUnreferencedArtifacts).toHaveBeenCalledWith({ tag: "prisma" });
  });

  it("answers 500 when the retention pass throws", async () => {
    lib.pruneUnreferencedArtifacts.mockRejectedValue(new Error("unreadable manifest"));

    const res = await pruneArtifacts(cronReq("/api/cron/prune-artifacts"));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
  });
});

describe("GET /api/cron/deliver-notifications", () => {
  beforeEach(() => {
    lib.evaluateHostTransitions.mockResolvedValue({ queued: 2 });
    lib.deliverDue.mockResolvedValue({ delivered: 3, failed: 0 });
    lib.purge.mockResolvedValue({ deleted: 4 });
  });

  it("runs the three phases in order and spreads the delivery result into the body", async () => {
    const order: string[] = [];
    lib.evaluateHostTransitions.mockImplementation(async () => (order.push("evaluation"), { queued: 2 }));
    lib.deliverDue.mockImplementation(async () => (order.push("delivery"), { delivered: 3, failed: 0 }));
    lib.purge.mockImplementation(async () => (order.push("housekeeping"), { deleted: 4 }));

    const res = await deliverNotifications(cronReq("/api/cron/deliver-notifications"));

    expect(res.status).toBe(200);
    // `failed` from the delivery result is overwritten by the list of failed phases.
    expect(await res.json()).toEqual({
      delivered: 3,
      transitions: { queued: 2 },
      housekeeping: { deleted: 4 },
      failed: [],
    });
    expect(order).toEqual(["evaluation", "delivery", "housekeeping"]);
    expect(lib.purge.mock.calls[0][1]).toBeInstanceOf(Date);
  });

  it.each([
    ["evaluation", lib.evaluateHostTransitions, { delivered: 3, transitions: null, housekeeping: { deleted: 4 } }],
    ["delivery", lib.deliverDue, { transitions: { queued: 2 }, housekeeping: { deleted: 4 } }],
    ["housekeeping", lib.purge, { delivered: 3, transitions: { queued: 2 }, housekeeping: null }],
  ])("when %s throws, still runs the other phases and answers 500 naming it", async (name, failing, rest) => {
    failing.mockRejectedValue(new Error("boom"));

    const res = await deliverNotifications(cronReq("/api/cron/deliver-notifications"));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ...rest, failed: [name] });
    expect(lib.evaluateHostTransitions).toHaveBeenCalledTimes(1);
    expect(lib.deliverDue).toHaveBeenCalledTimes(1);
    expect(lib.purge).toHaveBeenCalledTimes(1);
  });

  it("lists every failed phase in order", async () => {
    lib.evaluateHostTransitions.mockRejectedValue(new Error("a"));
    lib.purge.mockRejectedValue(new Error("b"));

    const res = await deliverNotifications(cronReq("/api/cron/deliver-notifications"));

    expect(res.status).toBe(500);
    expect((await res.json()).failed).toEqual(["evaluation", "housekeeping"]);
  });
});
