import { describe, expect, it } from "vitest";
import { citationsJson, citationsOf } from "@/lib/case-narrative";

describe("narrative citations read from the Json column", () => {
  it("reads back what was stored", () => {
    const citations = [{ detectionId: "d1", claim: "ran a payload" }];
    expect(citationsOf(JSON.parse(JSON.stringify(citationsJson(citations))))).toEqual(citations);
  });

  it("reads a value that is not a citation list as no citations", () => {
    expect(citationsOf(null)).toEqual([]);
    expect(citationsOf({ detectionId: "d1", claim: "x" })).toEqual([]);
    expect(citationsOf([{ detectionId: 1, claim: "x" }])).toEqual([]);
  });
});
