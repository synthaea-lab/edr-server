import { Prisma, PrismaClient } from "@prisma/client";

/** Every action string the control plane writes to `audit_logs`. */
export type AuditAction =
  | "agent.ring.assignment"
  | "case.narrative.generate"
  | "content.ioc_feed.stage"
  | "content.release.auto_halt"
  | "content.release.create"
  | "content.release.halt"
  | "content.release.rollback"
  | "corpus.version.finalize"
  | "enrollment.create"
  | "notify.channel.create"
  | "notify.channel.delete"
  | "release.create"
  | "tenant.create";

export interface AuditEntry {
  tenantId: string;
  userId: string;
  action: AuditAction;
  resource: string;
  details?: Prisma.InputJsonValue;
}

/** A client or an open transaction: anything that can insert an audit row. */
export type AuditWriter = Pick<PrismaClient | Prisma.TransactionClient, "auditLog">;

/**
 * Writes one audit row. Pass the transaction the audited mutation runs in, so the mutation and
 * its audit row commit together or not at all: a mutation must never land without its entry.
 */
export function recordAudit(db: AuditWriter, entry: AuditEntry) {
  return db.auditLog.create({ data: entry });
}
