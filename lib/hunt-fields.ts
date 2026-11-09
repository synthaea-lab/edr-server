/**
 * The field validators shared by the hunt query parsers: `parseHuntQuery` (`lib/hunt.ts`),
 * `parseCaseQuery` (`lib/hunt-search.ts`) and `parseEventQuery` (`lib/hunt-events.ts`).
 *
 * Each one checks one field of untrusted JSON and returns it normalized (lists deduplicated in
 * first-seen order, text trimmed), or throws `HuntValidationError` with the message analysts see
 * in the console and the API. Pure and dependency-free: client components import the parsers.
 */

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Longest window a hunt may look back, in hours (90 days). */
export const MAX_WINDOW_HOURS = 24 * 90;
/** `text` bounds: a shorter needle matches nearly everything, a longer one is not a hunt. */
export const MIN_TEXT_LENGTH = 3;
export const MAX_TEXT_LENGTH = 256;
export const MAX_TECHNIQUES = 20;

export const TECHNIQUE_RE = /^T\d{4}(\.\d{3})?$/;

export class HuntValidationError extends Error {}

export function fail(message: string): never {
  throw new HuntValidationError(message);
}

/** A query object whose keys are all in `allowed`. */
export function queryRecord(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail("query must be an object");
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) fail(`unknown query field "${key}"`);
  return raw;
}

/** `query.kind` and `query.version` must be exactly these. */
export function expectKind(value: unknown, kind: string): void {
  if (value !== kind) fail(`query.kind must be "${kind}"`);
}

export function expectVersion(value: unknown, version: number): void {
  if (value !== version) fail(`query.version must be ${version}`);
}

/** An integer from 1 to `max`, such as a window length. */
export function windowField(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    fail(`query.${field} must be an integer from 1 to ${max}`);
  }
  return value;
}

export function lastHoursField(value: unknown): number {
  return windowField(value, "lastHours", MAX_WINDOW_HOURS);
}

export function stringList(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    fail(`query.${field} must be a list of 1 to ${max} strings`);
  }
  for (const item of value) if (typeof item !== "string") fail(`query.${field} must contain only strings`);
  return value as string[];
}

/** A list of 1 to `max` strings, each accepted by `isValid`, deduplicated. */
export function checkedList(
  value: unknown,
  field: string,
  max: number,
  isValid: (item: string) => boolean,
  rejection: (item: string) => string
): string[] {
  const list = stringList(value, field, max);
  for (const item of list) if (!isValid(item)) fail(rejection(item));
  return Array.from(new Set(list));
}

/** A deduplicated list of values from `allowed`; a wrong one is "not a `noun`". */
export function enumListField<T extends string>(value: unknown, field: string, allowed: readonly T[], noun: string): T[] {
  const isAllowed = (item: string): item is T => (allowed as readonly string[]).includes(item);
  return checkedList(value, field, allowed.length, isAllowed, (item) => `"${item}" is not ${noun}`) as T[];
}

export function techniquesField(value: unknown): string[] {
  return checkedList(
    value,
    "techniques",
    MAX_TECHNIQUES,
    (t) => TECHNIQUE_RE.test(t),
    (t) => `"${t}" is not an ATT&CK technique id (T1059 or T1059.001)`
  );
}

export function severitiesField(value: unknown): Severity[] {
  return enumListField(value, "severities", SEVERITIES, "a severity");
}

/** Free text, trimmed, of `MIN_TEXT_LENGTH` to `MAX_TEXT_LENGTH` characters. */
export function textField(value: unknown): string {
  if (typeof value !== "string") fail("query.text must be a string");
  const text = value.trim();
  if (text.length < MIN_TEXT_LENGTH || text.length > MAX_TEXT_LENGTH) {
    fail(`query.text must be ${MIN_TEXT_LENGTH} to ${MAX_TEXT_LENGTH} characters`);
  }
  return text;
}
