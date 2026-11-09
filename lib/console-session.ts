import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isAdminRole } from "@/lib/admin-auth";
import { memberRole } from "@/lib/members";
import { prisma } from "@/lib/prisma";

/** The tenant and user a console page renders for, from the session. */
export type ConsoleTenant = { tenantId: string; userId: string };

/** A `ConsoleTenant` that also says whether the user is an owner or admin of the tenant. */
export type ConsoleTenantWithRole = ConsoleTenant & { isAdmin: boolean };

/** A signed-in session with no active organization: the page shows `NoOrganization`. */
export type NoActiveOrganization = { noOrganization: true };

/**
 * The session guard of every console page. Reads the session with the request's headers (a bare
 * `getSession` call answers 500 "Headers is required", #810), redirects to the sign-in page when
 * there is none, and answers `{ noOrganization: true }` when the session has no active
 * organization. With `withRole`, it also looks the user's membership up so the page can decide
 * whether to show admin actions; the routes behind those actions check the role again.
 */
export async function requireConsoleTenant(): Promise<ConsoleTenant | NoActiveOrganization>;
export async function requireConsoleTenant(options: {
  withRole: true;
}): Promise<ConsoleTenantWithRole | NoActiveOrganization>;
export async function requireConsoleTenant(
  options: { withRole?: boolean } = {}
): Promise<ConsoleTenant | ConsoleTenantWithRole | NoActiveOrganization> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  const tenantId = session.session.activeOrganizationId;
  if (!tenantId) return { noOrganization: true };

  const tenant: ConsoleTenant = { tenantId, userId: session.user.id };
  if (!options.withRole) return tenant;
  return { ...tenant, isAdmin: isAdminRole(await memberRole(prisma, tenantId, tenant.userId)) };
}
