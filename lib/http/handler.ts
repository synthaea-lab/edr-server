import { NextResponse } from "next/server";
import { z } from "zod";

/**
 * An error a route handler throws to answer with a given status and message instead of the
 * generic 500. `route` turns it into `{ error: message, details? }`.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequest extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, message, details);
  }
}

export class NotFound extends HttpError {
  constructor(message: string) {
    super(404, message);
  }
}

/**
 * The response for an error this route knows how to answer, or `undefined` to fall through to
 * `route`'s default mapping. For errors only one route raises (an LLM failure → 502, the ingest
 * routes' refusal counting) so the wrapper does not need to know them.
 */
export type RouteErrorHook = (error: unknown) => NextResponse | undefined;

export type RouteOptions = { onError?: RouteErrorHook };

/**
 * Wraps an App Router handler with the one error mapping every route shares:
 *
 * - `HttpError` → its status, `{ error, details? }`;
 * - `ZodError` → 400, `{ error: "Invalid request", details: issues }` (the text the safeParse
 *   routes already answer with);
 * - anything else → logged under `name`, then 500 `{ error: "Internal server error" }`, so no
 *   stack or message from an unexpected failure reaches the caller.
 *
 * `options.onError` runs first and may answer a route-specific error itself.
 */
export function route<Args extends unknown[]>(
  name: string,
  handler: (...args: Args) => Promise<NextResponse>,
  options: RouteOptions = {}
): (...args: Args) => Promise<NextResponse> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return options.onError?.(error) ?? errorResponse(name, error);
    }
  };
}

function errorResponse(name: string, error: unknown): NextResponse {
  if (error instanceof HttpError) {
    const body = error.details === undefined
      ? { error: error.message }
      : { error: error.message, details: error.details };
    return NextResponse.json(body, { status: error.status });
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: "Invalid request", details: error.errors }, { status: 400 });
  }
  console.error(`${name} failed:`, error);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}
