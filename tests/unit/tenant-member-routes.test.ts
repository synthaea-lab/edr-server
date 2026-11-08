import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Any read of the database records the model it touched: a route that answers 401 must not
// have touched one, and a route that reached its own `catch` would answer 500 instead.
const touched = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy(
    {},
    {
      get(_target, model: string) {
        touched.push(model);
        throw new Error(`database touched: ${model}`);
      },
    }
  ),
}));

import { GET as listCases } from "@/app/api/cases/route";
import { GET as getCase } from "@/app/api/cases/[id]/route";
import { GET as getCaseGraph } from "@/app/api/cases/[id]/graph/route";
import { POST as regenerateNarrative } from "@/app/api/cases/[id]/narrative/regenerate/route";
import { GET as listFleetCases } from "@/app/api/fleet-cases/route";
import { GET as getFleetCase } from "@/app/api/fleet-cases/[id]/route";
import { GET as listHunts, POST as createHunt } from "@/app/api/hunts/route";
import { GET as getHunt, PATCH as updateHunt, DELETE as deleteHunt } from "@/app/api/hunts/[id]/route";
import { POST as runHunt } from "@/app/api/hunts/[id]/run/route";
import { GET as listHuntMatches } from "@/app/api/hunts/[id]/matches/route";
import { POST as graduateHunt } from "@/app/api/hunts/[id]/graduate/route";
import { POST as searchHunts } from "@/app/api/hunts/search/route";
import { GET as getAgent } from "@/app/api/agents/[agentId]/route";
import { GET as getAgentRing } from "@/app/api/agents/[agentId]/ring/route";
import { GET as listRingAgents } from "@/app/api/rings/[ring]/agents/route";
import { GET as getRingHealth } from "@/app/api/rings/[ring]/health/route";
import { GET as listOpsRings } from "@/app/api/ops/rings/route";
import { GET as listOpsFleet } from "@/app/api/ops/fleet/route";
import { GET as listReleases } from "@/app/api/release/route";
import { GET as listContentReleases } from "@/app/api/content/release/route";
import { GET as listCorpusVersions } from "@/app/api/corpus/versions/route";
import { GET as getPrevalence } from "@/app/api/prevalence/route";
import { GET as pivotGraph } from "@/app/api/graph/pivot/route";
import { GET as listNotificationChannels } from "@/app/api/notify/channels/route";
import { requireTenantMember } from "@/lib/admin-auth";

const params = { id: "c1", agentId: "a1", ring: "prod" };

type Handler = (req: NextRequest, context: { params: typeof params }) => Promise<NextResponse>;

const memberRoutes: Array<[name: string, method: string, path: string, handler: Handler]> = [
  ["cases list", "GET", "/api/cases", listCases],
  ["case detail", "GET", "/api/cases/c1", getCase],
  ["case graph", "GET", "/api/cases/c1/graph", getCaseGraph],
  ["case narrative regenerate", "POST", "/api/cases/c1/narrative/regenerate", regenerateNarrative],
  ["fleet cases list", "GET", "/api/fleet-cases", listFleetCases],
  ["fleet case detail", "GET", "/api/fleet-cases/f1", getFleetCase],
  ["hunts list", "GET", "/api/hunts", listHunts],
  ["hunt create", "POST", "/api/hunts", createHunt],
  ["hunt detail", "GET", "/api/hunts/h1", getHunt],
  ["hunt update", "PATCH", "/api/hunts/h1", updateHunt],
  ["hunt delete", "DELETE", "/api/hunts/h1", deleteHunt],
  ["hunt run", "POST", "/api/hunts/h1/run", runHunt],
  ["hunt matches", "GET", "/api/hunts/h1/matches", listHuntMatches],
  ["hunt graduate", "POST", "/api/hunts/h1/graduate", graduateHunt],
  ["hunt search", "POST", "/api/hunts/search", searchHunts],
  ["agent detail", "GET", "/api/agents/a1", getAgent],
  ["agent ring", "GET", "/api/agents/a1/ring", getAgentRing],
  ["ring agents", "GET", "/api/rings/prod/agents", listRingAgents],
  ["ring health", "GET", "/api/rings/prod/health", getRingHealth],
  ["ops rings", "GET", "/api/ops/rings", listOpsRings],
  ["ops fleet", "GET", "/api/ops/fleet", listOpsFleet],
  ["binary releases list", "GET", "/api/release?ring=prod", listReleases],
  ["content releases list", "GET", "/api/content/release", listContentReleases],
  ["corpus versions list", "GET", "/api/corpus/versions", listCorpusVersions],
  ["prevalence", "GET", "/api/prevalence?kind=domain&key=x.example", getPrevalence],
  ["graph pivot", "GET", "/api/graph/pivot?kind=domain&key=x.example", pivotGraph],
  ["notification channels list", "GET", "/api/notify/channels", listNotificationChannels],
];

function call(handler: Handler, method: string, path: string, headers: Record<string, string>) {
  const body = method === "GET" || method === "DELETE" ? undefined : JSON.stringify({});
  return handler(new NextRequest(`http://localhost${path}`, { method, headers, body }), { params });
}

beforeEach(() => {
  touched.length = 0;
});

describe("tenant member routes without an active organization", () => {
  it.each(memberRoutes)(
    "%s (%s %s) answers 401, not 500, and touches no data",
    async (_name, method, path, handler) => {
      const res = await call(handler, method, path, {});
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Authentication required" });
      expect(touched).toEqual([]);
    }
  );

  it.each(memberRoutes)(
    "%s (%s %s) refuses a session user who has no active organization",
    async (_name, method, path, handler) => {
      // What the middleware forwards for such a session: a user id, never a tenant id.
      const res = await call(handler, method, path, { "x-user-id": "u1" });
      expect(res.status).toBe(401);
      expect(touched).toEqual([]);
    }
  );
});

describe("requireTenantMember", () => {
  const withHeaders = (headers: Record<string, string>) =>
    new NextRequest("http://localhost/api/cases", { headers });

  it("lets a session with an active organization through with its tenant and user", () => {
    expect(requireTenantMember(withHeaders({ "x-tenant-id": "t1", "x-user-id": "u1" }))).toEqual({
      tenantId: "t1",
      userId: "u1",
    });
  });

  it("answers 401 for a request with no tenant or no user", () => {
    const incomplete: Array<Record<string, string>> = [{}, { "x-user-id": "u1" }, { "x-tenant-id": "t1" }];
    for (const headers of incomplete) {
      const result = requireTenantMember(withHeaders(headers));
      expect("response" in result && result.response.status).toBe(401);
    }
  });
});
