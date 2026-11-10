import { describe, expect, it } from "vitest";
import { isSeverity, outranks, ranksAtLeast, severityRank } from "@/lib/severity";

describe("severityRank", () => {
  it("orders low < medium < high < critical", () => {
    expect(["low", "medium", "high", "critical"].map(severityRank)).toEqual([0, 1, 2, 3]);
  });

  it("ranks an unknown severity below every known one", () => {
    expect(severityRank("severe")).toBe(-1);
  });
});

describe("isSeverity", () => {
  it("accepts the four known severities only", () => {
    expect(["low", "medium", "high", "critical"].every(isSeverity)).toBe(true);
    expect(isSeverity("Critical")).toBe(false);
  });
});

describe("outranks", () => {
  it("ranks critical above high above medium above low", () => {
    expect(outranks("critical", "high")).toBe(true);
    expect(outranks("high", "medium")).toBe(true);
    expect(outranks("medium", "low")).toBe(true);
  });

  it("does not outrank an equal or higher severity", () => {
    expect(outranks("medium", "high")).toBe(false);
    expect(outranks("high", "high")).toBe(false);
  });

  it("never lets an unknown severity outrank a known one", () => {
    expect(outranks("severe", "low")).toBe(false);
    expect(outranks("low", "severe")).toBe(true);
  });
});

describe("ranksAtLeast", () => {
  it("holds for an equal or higher severity", () => {
    expect(ranksAtLeast("high", "high")).toBe(true);
    expect(ranksAtLeast("critical", "high")).toBe(true);
  });

  it("fails for a lower severity", () => {
    expect(ranksAtLeast("medium", "high")).toBe(false);
  });
});
