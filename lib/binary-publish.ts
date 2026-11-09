import { loadReleaseArtifact, loadReleaseManifest } from "@/lib/release-manifest";
import type { ReleaseManifest } from "@/lib/release-manifest";

/**
 * Publish-time checks for a binary release (ADR-0015, #30), the counterpart of
 * `lib/content-publish.ts#validatePublishable`: nothing is published that an agent could not
 * install. The Ed25519 signature is not checked here (the server never holds the key); every
 * agent verifies it before staging.
 */
export type BinaryPublishable =
  | { ok: true; manifest: ReleaseManifest }
  | { ok: false; error: string };

/**
 * The manifest must hash to `manifestSha256`, match the schema and carry `releaseVersion`, and
 * every entry's artifact must already be in storage and hash to its signed value.
 */
export async function validateBinaryPublishable(input: {
  releaseVersion: number;
  manifestUrl: string;
  manifestSha256: string;
}): Promise<BinaryPublishable> {
  const loaded = await loadReleaseManifest({
    id: "(unpublished)",
    manifestUrl: input.manifestUrl,
    manifestSha256: input.manifestSha256,
    releaseVersion: input.releaseVersion,
  });
  if (!loaded.ok) return { ok: false, error: loaded.error };
  for (const [entryPath, sha256] of Object.entries(loaded.manifest.entries)) {
    const artifact = await loadReleaseArtifact(input.releaseVersion, entryPath, sha256);
    if (!artifact.ok) {
      return { ok: false, error: `Artifact ${JSON.stringify(entryPath)}: ${artifact.error}` };
    }
  }
  return { ok: true, manifest: loaded.manifest };
}
