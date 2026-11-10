import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireTenantMember } from "@/lib/admin-auth";
import { route } from "@/lib/http/handler";
import { parseLimit } from "@/lib/http/query";

export const GET = route("GET /api/cases", async (req: NextRequest) => {
  const authed = requireTenantMember(req);
  if ("response" in authed) return authed.response;
  const { tenantId } = authed;
  const { searchParams } = new URL(req.url);

  const status = searchParams.get("status");
  const severity = searchParams.get("severity");

  const cases = await prisma.case.findMany({
    where: {
      tenantId,
      ...(status && { status }),
      ...(severity && { severity }),
    },
    orderBy: { createdAt: "desc" },
    take: parseLimit(searchParams, { fallback: 50, max: 1000 }),
  });

  return NextResponse.json({ cases });
});
