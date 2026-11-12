/**
 * Pure decision logic for the detection-grouping heuristic (issue #50),
 * separated from the Prisma calls in lib/case-grouping-store.ts
 * so it's unit-testable without a database.
 *
 * This is the honest limit of what's derivable from the technique ids stored
 * on `Detection` (`technique`, plus `meta.techniques`) — no MITRE tactic taxonomy
 * lookup exists in this codebase, so "related" means "same technique" or
 * "shares a base technique" (the part before the sub-technique dot, for each
 * id of a "/"-separated compound tag).
 */

import { outranks } from "@/lib/severity";

export const GROUPING_TIME_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Per-tenant cap on ungrouped detections read in one cron invocation (review,
 * Jihair54/Sollykhan): without a cap, the whole sweep ran inside one 30s
 * transaction over every ungrouped detection — fine for a small backlog
 * (measured: 2,000 detections grouped in ~21s) but a larger one (measured:
 * 20,000) blows the transaction timeout and rolls back with *no* progress,
 * every retry redoing the same doomed work. 500 leaves comfortable margin
 * under that measured rate, and staying well under `caseId: null` per pass
 * means the next cron tick picks up exactly where this one left off — a
 * backlog drains over several ticks instead of never draining at all.
 */
export const GROUPING_BATCH_SIZE = 500;

/**
 * The MITRE base techniques a `technique` field names: "T1059.001" -> {T1059}.
 * Rules tag a compound join with "/"-separated ids ("T1566.001/T1204.002",
 * "T1560/T1041"), so each id is split out before dropping its sub-technique
 * (#1053: splitting the whole string on "." turned that example into "T1566"
 * and lost T1204).
 */
export function baseTechniques(technique: string): Set<string> {
  return new Set(technique.split("/").map((id) => id.split(".")[0]));
}

/**
 * Some base technique named by `a` is also named by `b`. Two compound tags
 * sharing one id are related: each alert would group with an alert carrying
 * that id alone, and grouping is not meant to depend on arrival order.
 */
export function isRelatedTechnique(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const basesOfB = baseTechniques(b);
  return Array.from(baseTechniques(a)).some((base) => basesOfB.has(base));
}

// Same bounds as the ingest schema's structured `techniques` list (lib/detection-payload.ts).
const LISTED_TECHNIQUE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_LISTED_TECHNIQUES = 16;

/**
 * The tag grouping compares for one detection: its `technique` column joined with
 * the ids of `meta.techniques` (#1053). A structured detection stores only
 * `techniques[0]` in the column, so `T1566.001` + `T1204.002` grouped as `T1566`
 * alone. `meta` of a legacy detection is whatever the agent sent, so only a
 * bounded list of well-formed ids is read from it; anything else is ignored.
 */
export function groupingTechnique(technique: string, listed: unknown): string {
  if (!Array.isArray(listed)) {
    return technique;
  }
  const ids = listed
    .slice(0, MAX_LISTED_TECHNIQUES)
    .filter((id): id is string => typeof id === "string" && LISTED_TECHNIQUE.test(id));
  return Array.from(new Set([technique, ...ids])).join("/");
}

export function withinTimeWindow(a: Date, b: Date, windowMs: number = GROUPING_TIME_WINDOW_MS): boolean {
  return Math.abs(a.getTime() - b.getTime()) <= windowMs;
}

/** `meta.techniques` of a detection, if its `meta` is an object at all. */
function listedTechniques(meta: unknown): unknown {
  return isJsonObject(meta) ? meta.techniques : undefined;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A detection still at `caseId: null`, as the grouping pass reads it. */
export interface UngroupedDetection {
  id: string;
  agentId: string;
  timestamp: Date;
  /** The stored `technique` column; `meta.techniques` is joined to it for matching. */
  technique: string;
  severity: string;
  meta: unknown;
}

/** An open case and the evidence it already holds. */
export interface OpenCase {
  id: string;
  severity: string;
  /** `technique` is the grouping tag (`groupingTechnique`), not the stored column. */
  detections: { agentId: string; timestamp: Date; technique: string }[];
}

/** A case the pass opens, with its final severity and the detections it receives. */
export interface NewCase {
  title: string;
  severity: string;
  detectionIds: string[];
}

/** What one grouping pass writes. */
export interface GroupingPlan {
  /** In the order the pass opened them. */
  newCases: NewCase[];
  /** Existing open case id -> ids of the detections it receives. */
  assignments: Map<string, string[]>;
  /** Existing open case id -> its raised severity. */
  severityBumps: Map<string, string>;
}

interface Candidate {
  /** The case the plan writes to: one this pass opens, or an existing one by id. */
  ref: { newCase: NewCase } | { caseId: string };
  severity: string;
  evidence: OpenCase["detections"];
  /** Earliest evidence timestamp, the anchor of the time window; null while it has none. */
  startMs: number | null;
}

function existingCandidate(open: OpenCase): Candidate {
  const times = open.detections.map((d) => d.timestamp.getTime());
  return {
    ref: { caseId: open.id },
    severity: open.severity,
    evidence: [...open.detections],
    startMs: times.length === 0 ? null : times.reduce((a, b) => Math.min(a, b)),
  };
}

/**
 * The case a detection joins: the first candidate holding evidence from the same agent with a
 * related technique, within the window of the case's *earliest* detection (anchoring on the
 * latest one would let the window drift as detections chain together).
 */
function findMatch(candidates: readonly Candidate[], agentId: string, technique: string, timestamp: Date) {
  return candidates.find(
    (c) =>
      c.startMs !== null &&
      c.evidence.some((d) => d.agentId === agentId && isRelatedTechnique(d.technique, technique)) &&
      withinTimeWindow(new Date(c.startMs), timestamp)
  );
}

/** Opens a case for a detection that matched none, titled after its technique column and host. */
function openCandidate(
  plan: GroupingPlan,
  detection: UngroupedDetection,
  hostname: string | null | undefined
): Candidate {
  const newCase: NewCase = {
    title: `${detection.technique} activity on ${hostname ?? detection.agentId}`,
    severity: detection.severity,
    detectionIds: [],
  };
  plan.newCases.push(newCase);
  return { ref: { newCase }, severity: detection.severity, evidence: [], startMs: null };
}

/** Records `detection` as evidence of `target`, raising its severity if the detection outranks it. */
function attach(plan: GroupingPlan, target: Candidate, detection: UngroupedDetection, technique: string): void {
  const { ref } = target;
  if ("newCase" in ref) {
    ref.newCase.detectionIds.push(detection.id);
  } else {
    const ids = plan.assignments.get(ref.caseId) ?? [];
    ids.push(detection.id);
    plan.assignments.set(ref.caseId, ids);
  }

  if (outranks(detection.severity, target.severity)) {
    target.severity = detection.severity;
    if ("newCase" in ref) {
      ref.newCase.severity = detection.severity;
    } else {
      plan.severityBumps.set(ref.caseId, detection.severity);
    }
  }

  target.evidence.push({ agentId: detection.agentId, timestamp: detection.timestamp, technique });
  const ms = detection.timestamp.getTime();
  target.startMs = target.startMs === null ? ms : Math.min(target.startMs, ms);
}

/**
 * Decides, without touching the database, where each ungrouped detection goes: the first open
 * case it matches (existing cases first, then the ones this pass opened, in order), or a new case.
 * Detections are taken in the given order (oldest first), and each one becomes evidence later
 * ones can match. A case's severity is raised to the worst evidence it receives, never lowered;
 * a new case is planned with its final severity.
 */
export function planGrouping(
  ungrouped: readonly UngroupedDetection[],
  openCases: readonly OpenCase[],
  hostnameByAgentId: ReadonlyMap<string, string | null>
): GroupingPlan {
  const plan: GroupingPlan = { newCases: [], assignments: new Map(), severityBumps: new Map() };
  const candidates = openCases.map(existingCandidate);

  for (const detection of ungrouped) {
    const technique = groupingTechnique(detection.technique, listedTechniques(detection.meta));
    let target = findMatch(candidates, detection.agentId, technique, detection.timestamp);
    if (!target) {
      target = openCandidate(plan, detection, hostnameByAgentId.get(detection.agentId));
      candidates.push(target);
    }
    attach(plan, target, detection, technique);
  }

  return plan;
}
