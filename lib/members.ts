import type { PrismaClient } from "@prisma/client";

/**
 * The stored `Member.role` of a user in a tenant's organization, or `null` when the user is not a
 * member. The one membership lookup behind both the admin-only routes (`requireTenantAdmin`) and
 * the console pages that decide what to show (`requireConsoleTenant`). Read the role with
 * `isAdminRole`, never by comparing the string.
 */
export async function memberRole(
  db: Pick<PrismaClient, "member">,
  tenantId: string,
  userId: string
): Promise<string | null> {
  const member = await db.member.findFirst({
    where: { organizationId: tenantId, userId },
    select: { role: true },
  });
  return member?.role ?? null;
}
