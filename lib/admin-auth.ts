import { NextRequest, NextResponse } from "next/server";
import { memberRole } from "@/lib/members";
import { prisma } from "@/lib/prisma";
import { AuthenticationError, getTenantId, getUserId } from "@/lib/tenant";

/**
 * better-auth's organization plugin's own default roles (`owner`/`admin`/`member`,
 * `better-auth/plugins/organization/access/statement`) — there is no RBAC system of this
 * codebase's own yet (#89), so this reuses the roles already stored in `Member.role` rather
 * than adding a second notion of "admin".
 */
const ADMIN_ROLES = new Set(["owner", "admin"]);

/**
 * Whether a stored `Member.role` makes its holder an owner or admin. better-auth stores several
 * roles as one comma-separated string (`updateMemberRole` accepts an array; its own checks split
 * on ","), so a member given two roles must not be locked out of both just because the whole
 * string never equals "admin" or "owner". The one predicate for the routes (`requireTenantAdmin`)
 * and for the pages that decide what to show, so the two cannot drift apart.
 */
export function isAdminRole(role: string | null | undefined): boolean {
  return (role?.split(",").map((r) => r.trim()) ?? []).some((r) => ADMIN_ROLES.has(r));
}

/** The caller's tenant and user, as the middleware derived them from the session. */
export type TenantCaller = { tenantId: string; userId: string };

/**
 * Requires a session with an active organization: the gate of every route a plain member of the
 * tenant may call. A session with no active organization never gets an `x-tenant-id`/`x-user-id`
 * header (middleware strips any client-supplied one), so `getTenantId`/`getUserId` throw
 * `AuthenticationError`; that is a 401, not the generic 500 a route's own `catch` would turn it
 * into (review of #831).
 *
 * Returns the tenant and user ids on success, or the `NextResponse` to send back.
 */
export function requireTenantMember(req: NextRequest): TenantCaller | { response: NextResponse } {
  try {
    return { tenantId: getTenantId(req), userId: getUserId(req) };
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return {
        response: NextResponse.json({ error: "Authentication required" }, { status: 401 }),
      };
    }
    throw error;
  }
}

/**
 * Requires the caller to be an `owner` or `admin` member of their tenant's organization
 * (#803): a route whose docstring says "admin only" but only checked that a session existed
 * let any member of the tenant publish or roll back content fleet-wide. Refuses a caller with
 * no active organization with 401 (`requireTenantMember`), and a plain `member`, or a caller
 * with no membership row at all, with 403 before the route reads the request body.
 *
 * Returns the tenant and user ids on success, or the `NextResponse` to send back.
 */
export async function requireTenantAdmin(req: NextRequest): Promise<TenantCaller | { response: NextResponse }> {
  const caller = requireTenantMember(req);
  if ("response" in caller) return caller;

  if (!isAdminRole(await memberRole(prisma, caller.tenantId, caller.userId))) {
    return {
      response: NextResponse.json({ error: "Admin role required" }, { status: 403 }),
    };
  }

  return caller;
}
