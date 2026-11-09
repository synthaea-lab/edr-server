import { describe, it, expect, vi, afterEach } from "vitest";
import { NextResponse } from "next/server";
import { z } from "zod";
import { BadRequest, HttpError, NotFound, route } from "@/lib/http/handler";

function failingWith(error: unknown) {
  return route("GET /test", async () => {
    throw error;
  });
}

describe("route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the handler's own response untouched", async () => {
    const handler = route("GET /test", async (id: string) => NextResponse.json({ id }, { status: 201 }));

    const res = await handler("abc");

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "abc" });
  });

  it("answers an HttpError with its status and message", async () => {
    const res = await failingWith(new NotFound("Case not found"))();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Case not found" });
  });

  it("includes an HttpError's details when it has some", async () => {
    const res = await failingWith(new BadRequest("Bad ring", { allowed: ["canary"] }))();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Bad ring", details: { allowed: ["canary"] } });
  });

  it("answers any HttpError status, not only the named subclasses", async () => {
    const res = await failingWith(new HttpError(409, "Version already exists"))();

    expect(res.status).toBe(409);
  });

  it("answers a ZodError with 400 and its issues", async () => {
    const parsed = z.object({ ring: z.string() }).safeParse({});
    if (parsed.success) throw new Error("expected the parse to fail");

    const res = await failingWith(parsed.error)();
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid request");
    expect(body.details).toEqual(parsed.error.errors);
  });

  it("logs anything else under the route's name and answers a generic 500", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("connection reset: secret-host:5432");

    const res = await failingWith(failure)();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
    expect(log).toHaveBeenCalledWith("GET /test failed:", failure);
  });

  it("lets onError answer a route-specific error first", async () => {
    class UpstreamError extends Error {}
    const handler = route(
      "POST /test",
      async () => {
        throw new UpstreamError("llm down");
      },
      { onError: (e) => (e instanceof UpstreamError ? NextResponse.json({}, { status: 502 }) : undefined) }
    );

    const res = await handler();

    expect(res.status).toBe(502);
  });

  it("falls back to the default mapping when onError declines", async () => {
    const handler = route(
      "POST /test",
      async () => {
        throw new NotFound("Case not found");
      },
      { onError: () => undefined }
    );

    const res = await handler();

    expect(res.status).toBe(404);
  });
});
