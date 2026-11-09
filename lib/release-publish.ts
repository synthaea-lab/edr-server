import { BinaryRelease, ContentRelease, Prisma, PrismaClient } from "@prisma/client";
import { AuditEntry, recordAudit } from "@/lib/audit";
import { validateBinaryPublishable } from "@/lib/binary-publish";
import { validatePublishable } from "@/lib/content-publish";

/**
 * Publishing a release to a ring, binary (ADR-0015) or content (ADR-0032). Both follow the same
 * steps: read the ring's latest release, decide the new number, refuse anything an agent could
 * not install or apply, then create the row and its audit entry in one transaction, so a
 * release never goes out unaudited. The callers only map the outcome to HTTP.
 */
export type ReleaseDb = Pick<PrismaClient, "$transaction" | "binaryRelease" | "contentRelease">;

interface PublishCommon {
  tenantId: string;
  userId: string;
  ring: string;
  manifestUrl: string;
  manifestSha256: string;
  /** ISO 8601; the publish time when absent. */
  releasedAt?: string;
}

export type PublishRequest =
  /** The caller names the number; it must be above the ring's latest (the agent's anti-rollback check). */
  | (PublishCommon & { kind: "binary"; releaseVersion: number })
  /**
   * The control plane numbers it one above the ring's highest, rolled-back releases included.
   * `restoresVersion` marks a corrective release answering a rollback's advice: it is recorded
   * in the audit entry, never checked against anything.
   */
  | (PublishCommon & { kind: "content"; restoresVersion?: number });

export type PublishOutcome =
  | { outcome: "created"; release: BinaryRelease | ContentRelease }
  /** `latest` is set when the requested number is not above the ring's latest release. */
  | { outcome: "conflict"; error: string; latest?: number }
  | { outcome: "unpublishable"; error: string };

export function publishRelease(db: ReleaseDb, request: PublishRequest): Promise<PublishOutcome> {
  return request.kind === "binary" ? publishBinary(db, request) : publishContent(db, request);
}

async function publishBinary(
  db: ReleaseDb,
  request: Extract<PublishRequest, { kind: "binary" }>
): Promise<PublishOutcome> {
  const { tenantId, userId, ring, releaseVersion, manifestUrl, manifestSha256 } = request;
  const latest = await db.binaryRelease.findFirst({
    where: { tenantId, ring },
    orderBy: { releaseVersion: "desc" },
  });
  if (latest && releaseVersion <= latest.releaseVersion) {
    return {
      outcome: "conflict",
      error: "releaseVersion must be greater than the ring's latest release",
      latest: latest.releaseVersion,
    };
  }

  const publishable = await validateBinaryPublishable({ releaseVersion, manifestUrl, manifestSha256 });
  if (!publishable.ok) return { outcome: "unpublishable", error: publishable.error };

  return createAudited(db, {
    create: (tx) => tx.binaryRelease.create({ data: releaseRow(request, releaseVersion) }),
    audit: (created) => ({
      tenantId,
      userId,
      action: "release.create",
      resource: `binary_releases/${created.id}`,
      details: {
        ring,
        releaseVersion,
        manifestUrl,
        entries: Object.keys(publishable.manifest.entries).length,
      },
    }),
    conflictError: "A release with this version already exists for the ring",
  });
}

async function publishContent(
  db: ReleaseDb,
  request: Extract<PublishRequest, { kind: "content" }>
): Promise<PublishOutcome> {
  const { tenantId, userId, ring, manifestUrl, manifestSha256, restoresVersion } = request;
  const latest = await db.contentRelease.findFirst({
    where: { tenantId, ring },
    orderBy: { releaseVersion: "desc" },
  });
  const releaseVersion = (latest?.releaseVersion || 0) + 1;

  const publishable = await validatePublishable({ ring, releaseVersion, manifestUrl, manifestSha256 });
  if (!publishable.ok) return { outcome: "unpublishable", error: publishable.error };

  return createAudited(db, {
    create: (tx) => tx.contentRelease.create({ data: releaseRow(request, releaseVersion) }),
    audit: (created) => ({
      tenantId,
      userId,
      action: "content.release.create",
      resource: `content_releases/${created.id}`,
      details: {
        ring,
        releaseVersion,
        manifestUrl,
        entries: publishable.manifest.entries.length,
        corrective: restoresVersion !== undefined,
        restoresVersion: restoresVersion ?? null,
      },
    }),
    // Another publish read the same highest release and took the number first (the
    // (tenant, ring, version) row is unique): the manifest signed for it is now stale.
    conflictError: "Another release took this number first; rebuild the manifest for the next one",
  });
}

/** The columns both release tables share, for a new active release. */
function releaseRow(request: PublishCommon, releaseVersion: number) {
  return {
    tenantId: request.tenantId,
    ring: request.ring,
    releaseVersion,
    manifestUrl: request.manifestUrl,
    manifestSha256: request.manifestSha256,
    status: "active",
    releasedAt: request.releasedAt ? new Date(request.releasedAt) : new Date(),
  };
}

/**
 * Creates the release and its audit row in one transaction. A unique violation on
 * (tenant, ring, version) means a concurrent publish took the number first: a conflict, not a
 * failure.
 */
async function createAudited<R extends BinaryRelease | ContentRelease>(
  db: Pick<PrismaClient, "$transaction">,
  steps: {
    create: (tx: Prisma.TransactionClient) => Promise<R>;
    audit: (created: R) => AuditEntry;
    conflictError: string;
  }
): Promise<PublishOutcome> {
  try {
    const release = await db.$transaction(async (tx) => {
      const created = await steps.create(tx);
      await recordAudit(tx, steps.audit(created));
      return created;
    });
    return { outcome: "created", release };
  } catch (error) {
    if (isUniqueViolation(error)) return { outcome: "conflict", error: steps.conflictError };
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}
