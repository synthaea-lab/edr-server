import { describe, expect, it } from "vitest";
import { HuntValidationError, parseHuntQuery } from "@/lib/hunt";
import { parseEventQuery } from "@/lib/hunt-events";
import { parseCaseQuery } from "@/lib/hunt-search";

/**
 * Pins the exact error message of each hunt query parser, and which check wins when several
 * fields are wrong. The console and the API show these messages to analysts as they are.
 */

const AGENT = "123e4567-e89b-12d3-a456-426614174000";
const hunt = { version: 1, lastHours: 24 };
const cases = { kind: "cases", version: 1, lastHours: 24 };
const events = { kind: "events", version: 1, lastDays: 1 };

type Case = [name: string, input: unknown, message: string];

function withBase(base: Record<string, unknown>): Case[] {
  return shared.map(([name, fields, message]): Case => [name, { ...base, ...fields }, message]);
}

function messageOf(parse: (input: unknown) => unknown, input: unknown): string {
  try {
    parse(input);
  } catch (e) {
    expect(e).toBeInstanceOf(HuntValidationError);
    return (e as Error).message;
  }
  throw new Error(`accepted ${JSON.stringify(input)}`);
}

const shared: [string, Record<string, unknown>, string][] = [
  ["fractional window", { lastHours: 1.5 }, "query.lastHours must be an integer from 1 to 2160"],
  ["window as a string", { lastHours: "24" }, "query.lastHours must be an integer from 1 to 2160"],
  ["window too long", { lastHours: 2161 }, "query.lastHours must be an integer from 1 to 2160"],
  ["techniques not a list", { techniques: "T1059" }, "query.techniques must be a list of 1 to 20 strings"],
  ["empty techniques", { techniques: [] }, "query.techniques must be a list of 1 to 20 strings"],
  ["too many techniques", { techniques: Array(21).fill("T1059") }, "query.techniques must be a list of 1 to 20 strings"],
  ["technique not a string", { techniques: [1059] }, "query.techniques must contain only strings"],
  ["bad technique", { techniques: ["T1059.1"] }, '"T1059.1" is not an ATT&CK technique id (T1059 or T1059.001)'],
  ["too many severities", { severities: ["low", "low", "low", "low", "low"] }, "query.severities must be a list of 1 to 4 strings"],
  ["bad severity", { severities: ["high", "urgent"] }, '"urgent" is not a severity'],
  ["text not a string", { text: 5 }, "query.text must be a string"],
  ["text too short once trimmed", { text: "  ab  " }, "query.text must be 3 to 256 characters"],
  ["text too long", { text: "x".repeat(257) }, "query.text must be 3 to 256 characters"],
];

describe("parseHuntQuery messages", () => {
  it.each<Case>([
    ["not an object", null, "query must be an object"],
    ["an array", [], "query must be an object"],
    ["unknown field first", { version: 2, table: "users" }, 'unknown query field "table"'],
    ["version before window", { version: 2, lastHours: 0 }, "query.version must be 1"],
    ["techniques before severities", { ...hunt, severities: ["urgent"], techniques: ["x"] }, '"x" is not an ATT&CK technique id (T1059 or T1059.001)'],
    ["bad agent id", { ...hunt, agentIds: ["x"] }, '"x" is not an agent id'],
    ["too many agent ids", { ...hunt, agentIds: Array(51).fill(AGENT) }, "query.agentIds must be a list of 1 to 50 strings"],
    ...withBase(hunt),
  ])("%s", (_name, input, message) => {
    expect(messageOf(parseHuntQuery, input)).toBe(message);
  });
});

describe("parseCaseQuery messages", () => {
  it.each<Case>([
    ["not an object", "x", "query must be an object"],
    ["unknown field first", { kind: "x", agentIds: [] }, 'unknown query field "agentIds"'],
    ["kind before version", { kind: "x", version: 2 }, 'query.kind must be "cases"'],
    ["version before window", { kind: "cases", version: 2, lastHours: 0 }, "query.version must be 1"],
    ["severities before techniques", { ...cases, techniques: ["x"], severities: ["urgent"] }, '"urgent" is not a severity'],
    ["bad status", { ...cases, statuses: ["closed"] }, '"closed" is not a case status'],
    ["too many statuses", { ...cases, statuses: Array(5).fill("open") }, "query.statuses must be a list of 1 to 4 strings"],
    ...withBase(cases),
  ])("%s", (_name, input, message) => {
    expect(messageOf(parseCaseQuery, input)).toBe(message);
  });
});

describe("parseEventQuery messages", () => {
  it.each<Case>([
    ["not an object", [], "query must be an object"],
    ["unknown field first", { kind: "x", lastHours: 1 }, 'unknown query field "lastHours"'],
    ["kind before version", { kind: "x", version: 2 }, 'query.kind must be "events"'],
    ["version before window", { kind: "events", version: 2, lastDays: 0 }, "query.version must be 1"],
    ["window too long", { ...events, lastDays: 91 }, "query.lastDays must be an integer from 1 to 90"],
    ["empty types", { ...events, types: [] }, "query.types must be a list of 1 to 20 strings"],
    ["bad type", { ...events, types: ["Exec"] }, '"Exec" is not an event type (lowercase letters, digits and underscores)'],
    ["where not an object", { ...events, where: [] }, "query.where must be an object"],
    ["unknown filter", { ...events, where: { tenantId: "x" } }, 'unknown filter "tenantId"'],
    ["empty filter", { ...events, where: { comm: "" } }, "query.where.comm must be a string of 1 to 1024 characters"],
    ["bad sha256", { ...events, where: { sha256: "ab" } }, "query.where.sha256 must be 64 hexadecimal digits"],
  ])("%s", (_name, input, message) => {
    expect(messageOf(parseEventQuery, input)).toBe(message);
  });
});

describe("normalized output", () => {
  it("dedupes lists in first-seen order and trims text, the same way in every parser", () => {
    const filters = { techniques: ["T1003.001", "T1059", "T1003.001"], severities: ["high", "low", "high"], text: " curl " };
    expect(parseHuntQuery({ ...hunt, ...filters, agentIds: [AGENT, AGENT] })).toEqual({
      ...hunt,
      techniques: ["T1003.001", "T1059"],
      severities: ["high", "low"],
      agentIds: [AGENT],
      text: "curl",
    });
    expect(parseCaseQuery({ ...cases, ...filters, statuses: ["resolved", "open", "resolved"] })).toEqual({
      ...cases,
      techniques: ["T1003.001", "T1059"],
      severities: ["high", "low"],
      statuses: ["resolved", "open"],
      text: "curl",
    });
    expect(parseEventQuery({ ...events, types: ["exec", "exec"], where: { sha256: "A".repeat(64) } })).toEqual({
      ...events,
      types: ["exec"],
      where: { sha256: "a".repeat(64) },
    });
  });
});
