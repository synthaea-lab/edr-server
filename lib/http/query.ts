/** The row-count bounds a list route accepts for its `limit` query parameter. */
export type LimitBounds = {
  /** The count used when `limit` is absent or not a whole number. */
  fallback: number;
  max: number;
  min?: number;
};

const WHOLE_NUMBER = /^-?\d+$/;

/**
 * The `limit` query parameter as a row count for `take`: `fallback` when it is absent or not a
 * whole number (so `?limit=abc` cannot reach Prisma as `NaN`), otherwise clamped to
 * `[min, max]` (so a negative count cannot flip the query's order).
 */
export function parseLimit(searchParams: URLSearchParams, { fallback, max, min = 1 }: LimitBounds): number {
  const raw = searchParams.get("limit");
  if (raw === null || !WHOLE_NUMBER.test(raw)) return fallback;
  return Math.min(Math.max(Number(raw), min), max);
}
