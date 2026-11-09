import { describe, it, expect } from "vitest";
import { GROUPING_TIME_WINDOW_MS, planGrouping, type OpenCase, type UngroupedDetection } from "@/lib/case-grouping";

const T0 = new Date("2026-01-01T00:00:00Z").getTime();
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const HOSTS = new Map([
  ["agent-a", "host-a"],
  ["agent-b", "host-b"],
]);

let seq = 0;
function detection(overrides: Partial<UngroupedDetection> = {}): UngroupedDetection {
  seq += 1;
  return {
    id: `d${seq}`,
    agentId: "agent-a",
    timestamp: at(0),
    technique: "T1059.001",
    severity: "medium",
    meta: {},
    ...overrides,
  };
}

function openCase(id: string, severity: string, evidence: Partial<OpenCase["detections"][number]>[]): OpenCase {
  return {
    id,
    severity,
    detections: evidence.map((d) => ({ agentId: "agent-a", timestamp: at(0), technique: "T1059.001", ...d })),
  };
}

describe("planGrouping", () => {
  it("plans nothing for no detections", () => {
    const plan = planGrouping([], [openCase("c1", "low", [{}])], HOSTS);
    expect(plan).toEqual({ newCases: [], assignments: new Map(), severityBumps: new Map() });
  });

  it("opens one case titled after the technique column and hostname, falling back to the agent id", () => {
    const a = detection({ technique: "T1566.001", meta: { techniques: ["T1566.001", "T1204.002"] } });
    const b = detection({ agentId: "agent-unknown", technique: "T1105" });
    const plan = planGrouping([a, b], [], HOSTS);
    expect(plan.newCases).toEqual([
      { title: "T1566.001 activity on host-a", severity: "medium", detectionIds: [a.id] },
      { title: "T1105 activity on agent-unknown", severity: "medium", detectionIds: [b.id] },
    ]);
  });

  it("attaches a related detection from the same agent to an existing open case", () => {
    const d = detection({ technique: "T1059.003", timestamp: at(10) });
    const plan = planGrouping([d], [openCase("c1", "high", [{}])], HOSTS);
    expect(plan.newCases).toEqual([]);
    expect(plan.assignments).toEqual(new Map([["c1", [d.id]]]));
    expect(plan.severityBumps).toEqual(new Map());
  });

  it("does not attach across agents, unrelated techniques or outside the window", () => {
    const open = [openCase("c1", "low", [{}])];
    const otherAgent = detection({ agentId: "agent-b", timestamp: at(1) });
    const unrelated = detection({ technique: "T1105", timestamp: at(1) });
    const late = detection({ timestamp: new Date(T0 + GROUPING_TIME_WINDOW_MS + 1) });
    for (const d of [otherAgent, unrelated, late]) {
      const plan = planGrouping([d], open, HOSTS);
      expect(plan.assignments.size).toBe(0);
      expect(plan.newCases).toHaveLength(1);
    }
  });

  it("matches on meta.techniques of the incoming detection and on the stored evidence tag", () => {
    const d = detection({ technique: "T1566.001", meta: { techniques: ["T1566.001", "T1204.002"] }, timestamp: at(1) });
    const plan = planGrouping([d], [openCase("c1", "low", [{ technique: "T1204" }])], HOSTS);
    expect(plan.assignments).toEqual(new Map([["c1", [d.id]]]));
  });

  it("never matches an open case without evidence", () => {
    const d = detection();
    const plan = planGrouping([d], [openCase("empty", "low", [])], HOSTS);
    expect(plan.assignments.size).toBe(0);
    expect(plan.newCases).toHaveLength(1);
  });

  it("prefers the first matching case, existing cases before new ones", () => {
    const d = detection({ timestamp: at(5) });
    const plan = planGrouping([d], [openCase("c1", "low", [{}]), openCase("c2", "low", [{}])], HOSTS);
    expect(plan.assignments).toEqual(new Map([["c1", [d.id]]]));
  });

  it("lets later detections join a case opened earlier in the same pass", () => {
    const first = detection({ timestamp: at(0) });
    const second = detection({ technique: "T1059.003", timestamp: at(10) });
    const plan = planGrouping([first, second], [], HOSTS);
    expect(plan.newCases).toHaveLength(1);
    expect(plan.newCases[0].detectionIds).toEqual([first.id, second.id]);
  });

  it("anchors the window on the case's earliest evidence, so it does not drift", () => {
    const ds = [0, 20, 40, 60].map((m) => detection({ timestamp: at(m) }));
    const plan = planGrouping(ds, [], HOSTS);
    expect(plan.newCases.map((c) => c.detectionIds)).toEqual([
      [ds[0].id, ds[1].id],
      [ds[2].id, ds[3].id],
    ]);
  });

  it("anchors on the earliest existing evidence, whatever its order", () => {
    const open = openCase("c1", "low", [{ timestamp: at(25) }, { timestamp: at(0) }]);
    const plan = planGrouping([detection({ timestamp: at(40) })], [open], HOSTS);
    expect(plan.assignments.size).toBe(0);
  });

  it("raises severity to the worst evidence, never lowers it, with one bump per existing case", () => {
    const ds = [
      detection({ severity: "high", timestamp: at(1) }),
      detection({ severity: "low", timestamp: at(2) }),
      detection({ severity: "critical", timestamp: at(3) }),
    ];
    const plan = planGrouping(ds, [openCase("c1", "medium", [{}])], HOSTS);
    expect(plan.severityBumps).toEqual(new Map([["c1", "critical"]]));
    expect(plan.assignments.get("c1")).toEqual(ds.map((d) => d.id));
  });

  it("plans a new case with its final severity", () => {
    const ds = [detection({ severity: "low" }), detection({ severity: "high", timestamp: at(1) })];
    const plan = planGrouping(ds, [], HOSTS);
    expect(plan.newCases).toEqual([
      { title: "T1059.001 activity on host-a", severity: "high", detectionIds: ds.map((d) => d.id) },
    ]);
  });

  it("never lets an unknown severity outrank a known one", () => {
    const plan = planGrouping([detection({ severity: "info", timestamp: at(1) })], [openCase("c1", "low", [{}])], HOSTS);
    expect(plan.severityBumps.size).toBe(0);
  });

  it("does not modify its inputs", () => {
    const open = [openCase("c1", "low", [{}])];
    const snapshot = structuredClone(open);
    planGrouping([detection({ severity: "high", timestamp: at(1) })], open, HOSTS);
    expect(open).toEqual(snapshot);
  });
});
