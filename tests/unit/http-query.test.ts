import { describe, expect, it } from "vitest";
import { type LimitBounds, parseLimit } from "@/lib/http/query";

const BOUNDS: LimitBounds = { fallback: 50, max: 1000 };

const limitOf = (query: string, bounds = BOUNDS) => parseLimit(new URLSearchParams(query), bounds);

describe("parseLimit", () => {
  it("returns the requested count when it is within bounds", () => {
    expect(limitOf("limit=25")).toBe(25);
  });

  it("returns the fallback when limit is absent", () => {
    expect(limitOf("")).toBe(50);
  });

  it.each(["abc", "", "12abc", "1.5", " 7", "Infinity"])("returns the fallback for the non-integer %j", (raw) => {
    expect(limitOf(`limit=${encodeURIComponent(raw)}`)).toBe(50);
  });

  it("caps a count above max at max", () => {
    expect(limitOf("limit=5000")).toBe(1000);
  });

  it("raises zero and negative counts to min, which defaults to 1", () => {
    expect(limitOf("limit=0")).toBe(1);
    expect(limitOf("limit=-3")).toBe(1);
    expect(limitOf("limit=-3", { ...BOUNDS, min: 5 })).toBe(5);
  });
});
