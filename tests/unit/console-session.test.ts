import { beforeEach, describe, expect, it, vi } from "vitest";

// The session guard of the console pages, with the session, the request headers and Prisma mocked.
const getSession = vi.hoisted(() => vi.fn());
const db = vi.hoisted(() => ({ member: { findFirst: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "session=s1" }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));

import { requireConsoleTenant } from "@/lib/console-session";

const signedIn = (activeOrganizationId: string | null) => ({
  session: { activeOrganizationId },
  user: { id: "u1" },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireConsoleTenant", () => {
  it("reads the session with the request's headers", async () => {
    getSession.mockResolvedValue(signedIn("t1"));
    await requireConsoleTenant();
    expect(getSession.mock.calls[0][0].headers.get("cookie")).toBe("session=s1");
  });

  it("redirects a visitor with no session to the sign-in page", async () => {
    getSession.mockResolvedValue(null);
    await expect(requireConsoleTenant()).rejects.toThrow("redirect /login");
    await expect(requireConsoleTenant({ withRole: true })).rejects.toThrow("redirect /login");
  });

  it("answers no organization for a session without an active organization, without a member lookup", async () => {
    getSession.mockResolvedValue(signedIn(null));
    expect(await requireConsoleTenant()).toEqual({ noOrganization: true });
    expect(await requireConsoleTenant({ withRole: true })).toEqual({ noOrganization: true });
    expect(db.member.findFirst).not.toHaveBeenCalled();
  });

  it("answers the session's tenant and user, without a member lookup when no role is asked for", async () => {
    getSession.mockResolvedValue(signedIn("t1"));
    expect(await requireConsoleTenant()).toEqual({ tenantId: "t1", userId: "u1" });
    expect(db.member.findFirst).not.toHaveBeenCalled();
  });

  it("looks the role up by the session's own tenant and user", async () => {
    getSession.mockResolvedValue(signedIn("t1"));
    db.member.findFirst.mockResolvedValue({ role: "member" });
    await requireConsoleTenant({ withRole: true });
    expect(db.member.findFirst).toHaveBeenCalledWith({
      where: { organizationId: "t1", userId: "u1" },
      select: { role: true },
    });
  });

  it.each([
    ["owner", true],
    ["admin", true],
    ["member, admin", true],
    ["member", false],
  ])("says a member with role %j is admin: %s", async (role, isAdmin) => {
    getSession.mockResolvedValue(signedIn("t1"));
    db.member.findFirst.mockResolvedValue({ role });
    expect(await requireConsoleTenant({ withRole: true })).toEqual({ tenantId: "t1", userId: "u1", isAdmin });
  });

  it("says a user with no membership row is not admin", async () => {
    getSession.mockResolvedValue(signedIn("t1"));
    db.member.findFirst.mockResolvedValue(null);
    expect(await requireConsoleTenant({ withRole: true })).toEqual({ tenantId: "t1", userId: "u1", isAdmin: false });
  });
});
