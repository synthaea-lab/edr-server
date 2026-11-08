/**
 * Sibling checkouts of the public Synthaea repositories (synthaea-lab/agent, server, ml,
 * rules).
 *
 * The server is developed on its own, but a few contract tests read files owned by a
 * sibling — the agent's schema fixtures, the ML golden snapshot, the shipped IOC feeds.
 * Clone the repositories side by side, so siblings sit next to this one:
 *
 *   <root>/{agent,server,ml,rules}
 *
 * `SYNTHAEA_ROOT` points at that parent directory (default: this repo's parent). A test that needs an absent sibling is
 * skipped, unless `SYNTHAEA_REQUIRE_SIBLINGS=1` (set by CI), where it fails instead: a
 * contract test must never go quietly missing where it is supposed to run.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { it } from "vitest";

export type Sibling = "agent" | "server" | "ml" | "rules";

/** The parent directory holding the sibling checkouts. */
export const SIBLINGS_ROOT = path.resolve(process.env.SYNTHAEA_ROOT ?? path.join(__dirname, "../../.."));

const required = process.env.SYNTHAEA_REQUIRE_SIBLINGS === "1";

/** The absolute path of `rel` inside sibling `repo`, whether or not it exists. */
export function siblingPath(repo: Sibling, rel: string): string {
  return path.join(SIBLINGS_ROOT, repo, rel);
}

/**
 * Whether `rel` exists in sibling `repo`. With `SYNTHAEA_REQUIRE_SIBLINGS=1`, a missing
 * one throws, failing the suite at collection time.
 */
export function hasSibling(repo: Sibling, rel: string): boolean {
  const target = siblingPath(repo, rel);
  if (existsSync(target)) return true;
  const hint = `needs sibling repo \`${repo}\` (${target}); check out synthaea-lab/${repo} next to this repo as ${repo}/ or set SYNTHAEA_ROOT`;
  if (required) throw new Error(`SYNTHAEA_REQUIRE_SIBLINGS=1 but this test ${hint}`);
  console.warn(`skipped: ${hint}`);
  return false;
}

/** `it`, skipped (or failing under `SYNTHAEA_REQUIRE_SIBLINGS=1`) when `rel` is absent from `repo`. */
export const itWithSibling = (repo: Sibling, rel: string) => it.skipIf(!hasSibling(repo, rel));
