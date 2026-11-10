/**
 * The detection severity scale, the one place its order is written down. Pure and
 * dependency-free: client components import it (through `lib/hunt`).
 */

/** Every severity, least severe first. */
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export function isSeverity(value: string): value is Severity {
  return SEVERITIES.some((severity) => severity === value);
}

/** Position on the scale; an unknown severity ranks below every known one (-1). */
export function severityRank(severity: string): number {
  return SEVERITIES.findIndex((known) => known === severity);
}

/** True when `candidate` is strictly more severe than `current`. */
export function outranks(candidate: string, current: string): boolean {
  return severityRank(candidate) > severityRank(current);
}

/** True when `candidate` is at least as severe as `current`. */
export function ranksAtLeast(candidate: string, current: string): boolean {
  return severityRank(candidate) >= severityRank(current);
}
