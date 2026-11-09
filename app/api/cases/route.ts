import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireTenantMember } from "@/lib/admin-auth";
import { route } from "@/lib/http/handler";

export const GET = route("GET /api/cases", async (req: NextRequest) => {
  const authed = requireTenantMember(req);
  if ("response" in authed) return authed.response;
  const { tenantId } = authed;
  const { searchParams } = new URL(req.url);

  const status = searchParams.get("status");
  const severity = searchParams.get("severity");
  const limit = parseInt(searchParams.get("limit") || "50", 10);

  const cases = await prisma.case.findMany({
    where: {
      tenantId,
      ...(status && { status }),
      ...(severity && { severity }),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 1000), // Cap at 1000
  });

  return NextResponse.json({ cases });
});
